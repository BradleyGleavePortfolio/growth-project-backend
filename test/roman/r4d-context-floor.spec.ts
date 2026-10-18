// test/roman/r4d-context-floor.spec.ts
//
// R4d: the client context Roman reads never carries a stored daily target
// under the client's calorie floor (decision 6). It shows max(target, floor),
// scales the grams by floor/target (same math as the R4c post-check) and
// computes what is left today from that. Above the floor nothing changes.

import 'reflect-metadata';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { renderClientContext } from '../../src/roman/context/roman-client-context.renderer';
import { makePersonaDb, FakeSafetyIntakeSource, NOW, P1 } from './fixtures/roman-personas';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';

const caller = { id: P1, role: 'student' };

function setup() {
  const db = makePersonaDb();
  return { db, svc: new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource(), grantAllEgress()) };
}

describe('R4d: the context Roman reads uses the floor-lifted target', () => {
  it('a 1,000 kcal coach target for a woman reads as 1,200 kcal, grams and kcal left follow it', async () => {
    const { db, svc } = setup();
    // P1 is female (floor 1,200) and has logged 780 kcal, 62 g protein,
    // 70 g carbs and 26 g fat today.
    Object.assign(
      db.raw.macroTargets.find((r) => r.id === 'mt-maya-1')!,
      {
        calories_kcal: 1000,
        protein_g: 70,
        carbs_g: 110,
        fats_g: 31,
      },
    );
    const { context } = await svc.build(caller, NOW);
    expect(context.targets).toMatchObject({
      calories: 1200,
      protein_g: 84,
      carbs_g: 132,
      fat_g: 37,
    });
    expect(context.macro_method).toMatchObject({ floor_kcal: 1200, floor_applied: true });
    expect(context.today).toMatchObject({
      kcal: 780,
      remaining_kcal: 420,
      remaining_protein_g: 22,
      remaining_carbs_g: 62,
      remaining_fat_g: 11,
      pct_kcal: 65,
    });
    expect(renderClientContext(context).rendered).not.toContain('1000');
  });

  it('a target above the floor is rendered byte for byte as before', async () => {
    const { svc } = setup();
    const { context } = await svc.build(caller, NOW);
    expect(context.targets).toMatchObject({
      calories: 1450,
      protein_g: 115,
      carbs_g: 150,
      fat_g: 45,
    });
    expect(context.today.remaining_kcal).toBe(670);
    expect(renderClientContext(context).hash).toBe(
      'd9bf9e715ea24bd6fec390583ee67f2bf7f286e6aff56784411cc6d3ab695152',
    );
  });
});
