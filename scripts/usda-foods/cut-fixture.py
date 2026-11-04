#!/usr/bin/env python3
"""FOOD-USDA-BE (agent 193): cut test/fixtures/usda-foods from the two USDA CSV downloads.

CI never downloads USDA's files. test/usda-foods-file.spec.ts runs build.py on
this small cut (the CSV rows of the foods below, unchanged, with only the
nutrient rows build.py reads) and checks that every food it builds is, field
for field, the row prisma/data/usda-foods.jsonl.gz holds for it. Run again:

  python3 scripts/usda-foods/cut-fixture.py \\
    FoodData_Central_sr_legacy_food_csv_2018-04.zip \\
    FoodData_Central_foundation_food_csv_2026-04-30.zip test/fixtures/usda-foods
"""
import csv
import io
import os
import sys
import zipfile

# SR Legacy: eggs, rice, 2% milk, green beans, scrambled egg, strawberries, beef tallow, a food with no portion,
# a branded food, two foods a built-in food stands for (left out), and more.
SR_LEGACY = ['167512', '167607', '167762', '168172', '168877', '169961', '170870', '170893', '171077', '171400',
             '172187', '173567']
# Foundation: hummus, grape tomatoes, frozen egg (each with a portion), green beans, kiwifruit and carrots (no portion), salt and apples (energy from Atwater General),
# chicken (carbohydrate below zero, stored as 0), a lab row with no energy figure (left out), and more.
FOUNDATION = ['321358', '321360', '323604', '2346400', '327046', '746764', '746775', '1750339', '1750340', '2727566', '2727567', '747430', '747431']
NUTRIENTS = {'1008', '2047', '2048', '1062', '1003', '1004', '1005', '1079', '2000', '1063', '1093', '1258', '1292',
             '1293'}


def cut(zip_path, list_file, ids, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    z = zipfile.ZipFile(zip_path)
    names = {n.rsplit('/', 1)[-1]: n for n in z.namelist()}
    wanted = set(ids)
    for name in (list_file, 'food.csv', 'food_nutrient.csv', 'food_portion.csv', 'food_category.csv',
                 'measure_unit.csv'):
        with z.open(names[name]) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8', newline=''))
            with open(os.path.join(out_dir, name), 'w', encoding='utf-8', newline='') as f:
                w = csv.DictWriter(f, fieldnames=reader.fieldnames, quoting=csv.QUOTE_ALL, lineterminator='\n')
                w.writeheader()
                for r in reader:
                    if 'fdc_id' in r and r['fdc_id'] not in wanted:
                        continue
                    if name == 'food_nutrient.csv' and r['nutrient_id'] not in NUTRIENTS:
                        continue
                    w.writerow(r)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('usage: cut-fixture.py <sr_legacy csv zip> <foundation csv zip> <out folder>')
    cut(sys.argv[1], 'sr_legacy_food.csv', SR_LEGACY, os.path.join(sys.argv[3], 'sr-legacy'))
    cut(sys.argv[2], 'foundation_food.csv', FOUNDATION, os.path.join(sys.argv[3], 'foundation'))
