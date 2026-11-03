#!/usr/bin/env python3
"""FOOD-USDA-BE (agent 193): build prisma/data/usda-foods.jsonl.gz from USDA's own files.

Reads two USDA FoodData Central CSV downloads and writes one row per food, in
the same shape the live import (FoodService.upsertFromUSDA) stores. Every
number comes from those files; nothing is typed by hand. Python 3 standard
library only, so anyone can run it again:

  curl -LO https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
  curl -LO https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip
  python3 scripts/usda-foods/build.py \
    FoodData_Central_sr_legacy_food_csv_2018-04.zip \
    FoodData_Central_foundation_food_csv_2026-04-30.zip \
    prisma/data/usda-foods.jsonl.gz

The output is the same bytes every run for the same two files.

File layout: gzip of JSON lines. Line 1 describes the build (the two files,
their sha256, the nutrient ids used, counts). Every other line is one food:
  fdc_id, data_type ("SR Legacy" or "Foundation"), name, usda_category,
  calories (kcal per 100 g), protein_g, carbs_g, fat_g, fiber_g, sugar_g,
  sodium_mg (all per 100 g), serving_description and serving_size_grams (the
  food's first measured portion; null and null when USDA lists none, and the
  loader then stores 100 g), and energy_from (which USDA energy figure gave
  the calories).

Rounding is the live import's: every nutrient to 0.1 (JavaScript Math.round,
halves up), calories and sodium to a whole number, a zero fibre, sugar or
sodium stored as null. A carbohydrate-by-difference below zero (ten Foundation
meats and fish) is stored as 0 and listed in line 1. A food with no energy
figure at all is left out and listed in line 1 with the reason.
"""
import csv
import gzip
import hashlib
import io
import json
import math
import sys
import zipfile

# USDA nutrient ids (nutrient.csv in both files). The live import matches the
# same nutrients by name; ids are used here because the CSV names differ from
# the API names for sugar.
ENERGY_KCAL = '1008'          # "Energy", KCAL
ENERGY_GENERAL = '2047'       # "Energy (Atwater General Factors)", KCAL
ENERGY_SPECIFIC = '2048'      # "Energy (Atwater Specific Factors)", KCAL
ENERGY_KJ = '1062'            # "Energy", kJ
PROTEIN = '1003'              # "Protein"
FAT = '1004'                  # "Total lipid (fat)"
CARBS = '1005'                # "Carbohydrate, by difference"
FIBER = '1079'                # "Fiber, total dietary"
SUGARS_TOTAL = '2000'         # SR Legacy "Sugars, Total" (API: "Sugars, total including NLEA"); Foundation "Total Sugars"
SUGARS_NLEA = '1063'          # "Sugars, Total NLEA" / "Sugars, Total"
SODIUM = '1093'               # "Sodium, Na", MG

UNDETERMINED_UNIT = '9999'


def js_round(x):
    """JavaScript Math.round: halves go up (Python's round() goes to even)."""
    return math.floor(x + 0.5)


def tenth(x):
    """The live import's getNutrient: Math.round(value * 10) / 10."""
    return js_round(x * 10) / 10


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


class Release:
    def __init__(self, path):
        self.path = path
        self.zip = zipfile.ZipFile(path)
        self.names = {n.rsplit('/', 1)[-1]: n for n in self.zip.namelist()}

    def rows(self, name):
        with self.zip.open(self.names[name]) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8', newline=''))


def amount_text(amount):
    value = float(amount)
    if value == int(value):
        return str(int(value))
    return ('%f' % value).rstrip('0').rstrip('.')


def portion_text(portion, units):
    unit = units.get(portion['measure_unit_id'], '')
    parts = [amount_text(portion['amount'])]
    if portion['measure_unit_id'] != UNDETERMINED_UNIT and unit:
        parts.append(unit)
    for extra in (portion['portion_description'], portion['modifier']):
        extra = ' '.join((extra or '').split())
        if extra:
            parts.append(extra)
    return ' '.join(parts)


def first_portion(portions, units):
    """The food's first measured portion: lowest seq_num, then lowest id, with grams and an amount."""
    usable = []
    for p in portions:
        try:
            grams = float(p['gram_weight'])
            amount = float(p['amount'])
        except ValueError:
            continue
        if grams <= 0 or amount <= 0:
            continue
        seq = int(p['seq_num']) if p['seq_num'].strip() else 1 << 30
        usable.append((seq, int(p['id']), p, grams))
    if not usable:
        return None, None
    usable.sort(key=lambda t: (t[0], t[1]))
    _, _, p, grams = usable[0]
    return portion_text(p, units), tenth(grams)


def read_release(path, list_file, data_type, skipped, below_zero):
    rel = Release(path)
    ids = [r['fdc_id'] for r in rel.rows(list_file)]
    wanted = set(ids)
    foods = {r['fdc_id']: r for r in rel.rows('food.csv') if r['fdc_id'] in wanted}
    categories = {r['id']: r['description'] for r in rel.rows('food_category.csv')}
    units = {r['id']: r['name'] for r in rel.rows('measure_unit.csv')}
    keep = {ENERGY_KCAL, ENERGY_GENERAL, ENERGY_SPECIFIC, ENERGY_KJ, PROTEIN, FAT, CARBS,
            FIBER, SUGARS_TOTAL, SUGARS_NLEA, SODIUM}
    nutrients = {}
    for r in rel.rows('food_nutrient.csv'):
        if r['fdc_id'] in wanted and r['nutrient_id'] in keep and r['amount'].strip():
            # The first figure for a nutrient wins, as the live import's find() does.
            nutrients.setdefault(r['fdc_id'], {}).setdefault(r['nutrient_id'], float(r['amount']))
    portions = {}
    for r in rel.rows('food_portion.csv'):
        if r['fdc_id'] in wanted:
            portions.setdefault(r['fdc_id'], []).append(r)

    out = []
    for fdc_id in ids:
        food = foods.get(fdc_id)
        name = ' '.join((food or {}).get('description', '').split()) if food else ''
        if not name:
            skipped.append({'fdc_id': fdc_id, 'data_type': data_type, 'why': 'no name in food.csv'})
            continue
        n = nutrients.get(fdc_id, {})
        get = lambda nid: tenth(n[nid]) if nid in n else 0
        energy_ids = [nid for nid in (ENERGY_KCAL, ENERGY_GENERAL, ENERGY_SPECIFIC, ENERGY_KJ) if nid in n]
        if not energy_ids:
            skipped.append({'fdc_id': fdc_id, 'data_type': data_type, 'name': name, 'why': 'no energy figure'})
            continue
        # The live import's order: Energy kcal, else Atwater General, else
        # Atwater Specific, else kJ / 4.184 (a zero falls through, as || does).
        calories, energy_from = 0, energy_ids[0]
        for nid in (ENERGY_KCAL, ENERGY_GENERAL, ENERGY_SPECIFIC):
            if get(nid):
                calories, energy_from = get(nid), nid
                break
        else:
            if ENERGY_KJ in n:
                calories, energy_from = js_round(get(ENERGY_KJ) / 4.184), ENERGY_KJ
        sugar = get(SUGARS_TOTAL) or get(SUGARS_NLEA)
        carbs = get(CARBS)
        if carbs < 0:
            # "By difference" is 100 g minus the other parts, so it can come out below
            # zero for a meat (USDA prints -0.5). No food has less than no carbohydrate:
            # store 0 and list the food in the header so a reviewer sees each one.
            below_zero.append({'fdc_id': int(fdc_id), 'name': name, 'usda_carbs_g': carbs})
            carbs = 0.0
        sodium = get(SODIUM)
        serving_description, serving_grams = first_portion(portions.get(fdc_id, []), units)
        out.append({
            'fdc_id': int(fdc_id),
            'data_type': data_type,
            'name': name,
            'usda_category': categories.get(food.get('food_category_id', ''), None),
            'calories': js_round(calories),
            'protein_g': get(PROTEIN),
            'carbs_g': carbs,
            'fat_g': get(FAT),
            'fiber_g': get(FIBER) or None,
            'sugar_g': sugar or None,
            'sodium_mg': js_round(sodium) if sodium else None,
            'serving_description': serving_description,
            'serving_size_grams': serving_grams,
            'energy_from': energy_from,
        })
    return out


def main(argv):
    if len(argv) != 4:
        sys.exit('usage: build.py <sr_legacy csv zip> <foundation csv zip> <out .jsonl.gz>')
    sr_path, fd_path, out_path = argv[1:]
    skipped, below_zero = [], []
    sr = read_release(sr_path, 'sr_legacy_food.csv', 'SR Legacy', skipped, below_zero)
    fd = read_release(fd_path, 'foundation_food.csv', 'Foundation', skipped, below_zero)
    foods = sorted(sr + fd, key=lambda f: f['fdc_id'])
    ids = [f['fdc_id'] for f in foods]
    if len(ids) != len(set(ids)):
        sys.exit('an fdc_id is in both files')
    header = {
        'about': 'FOOD-USDA-BE (agent 193): USDA SR Legacy and Foundation foods for release step 6 '
                 '(scripts/load-usda-foods.ts). Built by scripts/usda-foods/build.py; do not edit by hand.',
        'files': [
            {'data_type': 'SR Legacy', 'file': sr_path.rsplit('/', 1)[-1], 'sha256': sha256(sr_path), 'foods': len(sr)},
            {'data_type': 'Foundation', 'file': fd_path.rsplit('/', 1)[-1], 'sha256': sha256(fd_path), 'foods': len(fd)},
        ],
        'nutrient_ids': {
            'calories': [ENERGY_KCAL, ENERGY_GENERAL, ENERGY_SPECIFIC, ENERGY_KJ + ' / 4.184'],
            'protein_g': PROTEIN, 'carbs_g': CARBS, 'fat_g': FAT, 'fiber_g': FIBER,
            'sugar_g': [SUGARS_TOTAL, SUGARS_NLEA], 'sodium_mg': SODIUM,
        },
        'foods': len(foods),
        'with_portion': sum(1 for f in foods if f['serving_description']),
        'skipped': skipped,
        'carbs_below_zero_stored_as_0': below_zero,
    }
    buf = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=buf, mtime=0, compresslevel=9) as gz:
        for line in [header] + foods:
            gz.write((json.dumps(line, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    with open(out_path, 'wb') as f:
        f.write(buf.getvalue())
    print(f'{len(foods)} foods ({len(sr)} SR Legacy, {len(fd)} Foundation), '
          f'{header["with_portion"]} with a portion, {len(skipped)} skipped -> {out_path} '
          f'({len(buf.getvalue())} bytes)')


if __name__ == '__main__':
    main(sys.argv)
