/**
 * Seed catalog of common exercises used as a fallback when the
 * ExerciseDB RapidAPI integration is not configured (no
 * EXERCISEDB_API_KEY) or when the upstream is unreachable.
 *
 * The catalog covers push, pull, legs, cardio, and mobility so a coach
 * can build a credible plan on day one without an external dependency.
 *
 * Ids are namespaced with `seed:` so a downstream consumer can tell at
 * a glance which catalog the row came from. Once an EXERCISEDB_API_KEY
 * is present, the proxy results take precedence.
 */

import type { Exercise } from './exercise.entity';

const exercise = (
  id: string,
  name: string,
  bodyPart: string,
  equipment: string,
  target: string,
  secondaryMuscles: string[],
  instructions: string[],
): Exercise => ({
  id: `seed:${id}`,
  name,
  bodyPart,
  equipment,
  target,
  secondaryMuscles,
  instructions,
  gifUrl: '',
});

export const SEED_EXERCISES: Exercise[] = [
  // Push — chest / shoulders / triceps
  exercise('push-001', 'Barbell Bench Press', 'chest', 'barbell', 'pectorals', ['triceps', 'front delts'], [
    'Lie flat on a bench with feet planted on the floor.',
    'Grip the barbell slightly wider than shoulder width.',
    'Lower the bar to mid-chest under control.',
    'Press back to lockout, keeping the elbows at about 45 degrees.',
  ]),
  exercise('push-002', 'Incline Dumbbell Press', 'chest', 'dumbbell', 'pectorals', ['front delts', 'triceps'], [
    'Set an incline bench to roughly 30 degrees.',
    'Press both dumbbells overhead to lockout.',
    'Lower under control until the elbows drop slightly below the torso.',
    'Drive back up without flaring the elbows.',
  ]),
  exercise('push-003', 'Push Up', 'chest', 'body weight', 'pectorals', ['triceps', 'core'], [
    'Set hands shoulder-width on the floor with the body in a straight line.',
    'Lower the chest until it nearly touches the floor.',
    'Press back to lockout while keeping the core braced.',
  ]),
  exercise('push-004', 'Overhead Press', 'shoulders', 'barbell', 'front delts', ['triceps', 'upper chest'], [
    'Stand with feet hip-width and grip the bar at shoulder level.',
    'Brace the core and press the bar overhead.',
    'Lock out with the bar above the crown of the head.',
    'Lower under control to the front-rack position.',
  ]),
  exercise('push-005', 'Dumbbell Shoulder Press', 'shoulders', 'dumbbell', 'front delts', ['triceps', 'side delts'], [
    'Sit on a bench with the back supported.',
    'Press both dumbbells overhead until the elbows lock.',
    'Lower under control to ear level.',
  ]),
  exercise('push-006', 'Lateral Raise', 'shoulders', 'dumbbell', 'side delts', [], [
    'Stand with a dumbbell in each hand.',
    'Raise the arms out to the sides until parallel with the floor.',
    'Pause briefly, then lower under control.',
  ]),
  exercise('push-007', 'Triceps Pushdown', 'arms', 'cable', 'triceps', [], [
    'Stand at a cable station with a rope or bar at the top.',
    'Press the attachment down until the elbows lock.',
    'Return slowly without flaring the elbows.',
  ]),
  exercise('push-008', 'Skullcrusher', 'arms', 'barbell', 'triceps', [], [
    'Lie on a flat bench with the barbell pressed overhead.',
    'Lower the bar toward the forehead by hinging at the elbows.',
    'Extend the elbows back to lockout.',
  ]),
  exercise('push-009', 'Dip', 'chest', 'body weight', 'triceps', ['pectorals', 'front delts'], [
    'Support the body on parallel bars with arms locked.',
    'Lower until the shoulders are roughly level with the elbows.',
    'Press back to lockout without shrugging.',
  ]),
  exercise('push-010', 'Cable Chest Fly', 'chest', 'cable', 'pectorals', [], [
    'Set the cables at chest height and grasp a handle in each hand.',
    'Step forward and bring the hands together in a wide arc.',
    'Return under control without letting the shoulder roll forward.',
  ]),

  // Pull — back / biceps / rear delts
  exercise('pull-001', 'Pull Up', 'back', 'body weight', 'lats', ['biceps', 'mid back'], [
    'Hang from the bar with palms facing away, hands shoulder-width.',
    'Pull the chest toward the bar by driving the elbows down.',
    'Lower under control to a full hang.',
  ]),
  exercise('pull-002', 'Lat Pulldown', 'back', 'cable', 'lats', ['biceps'], [
    'Sit at a lat pulldown station and grip the bar slightly wider than shoulder width.',
    'Pull the bar to the upper chest.',
    'Return under control without letting the shoulders roll forward.',
  ]),
  exercise('pull-003', 'Barbell Row', 'back', 'barbell', 'mid back', ['lats', 'biceps'], [
    'Hinge at the hips with a flat back and the bar over mid-foot.',
    'Pull the bar to the lower ribs.',
    'Lower under control without losing the hinge.',
  ]),
  exercise('pull-004', 'Dumbbell Row', 'back', 'dumbbell', 'lats', ['mid back', 'biceps'], [
    'Brace one knee and hand on a bench with a dumbbell in the other hand.',
    'Pull the dumbbell to the hip without rotating the torso.',
    'Lower fully under control.',
  ]),
  exercise('pull-005', 'Seated Cable Row', 'back', 'cable', 'mid back', ['lats', 'biceps'], [
    'Sit at the cable station with a slight forward lean of the torso.',
    'Pull the handle to the lower sternum, driving the elbows back.',
    'Return slowly to a full stretch.',
  ]),
  exercise('pull-006', 'Face Pull', 'shoulders', 'cable', 'rear delts', ['mid back'], [
    'Set the cable just above eye level with a rope attachment.',
    'Pull the rope toward the face, separating the hands at the end.',
    'Pause, then return under control.',
  ]),
  exercise('pull-007', 'Barbell Curl', 'arms', 'barbell', 'biceps', ['forearms'], [
    'Stand with the bar at the hips, hands shoulder-width.',
    'Curl the bar by flexing at the elbows without swinging.',
    'Lower fully under control.',
  ]),
  exercise('pull-008', 'Dumbbell Hammer Curl', 'arms', 'dumbbell', 'biceps', ['forearms'], [
    'Stand with a dumbbell in each hand, palms facing the body.',
    'Curl the dumbbells with the palms staying inward.',
    'Lower under control.',
  ]),
  exercise('pull-009', 'Reverse Fly', 'shoulders', 'dumbbell', 'rear delts', ['mid back'], [
    'Hinge forward with a flat back and a dumbbell in each hand.',
    'Raise the arms out to the sides squeezing the shoulder blades.',
    'Lower under control.',
  ]),
  exercise('pull-010', 'Deadlift', 'back', 'barbell', 'erectors', ['glutes', 'hamstrings', 'lats'], [
    'Stand with the bar over mid-foot, hip-width stance.',
    'Hinge to grip the bar with a flat back.',
    'Drive the floor away while keeping the bar against the body.',
    'Stand tall, then lower under control.',
  ]),

  // Legs — quads / hamstrings / glutes / calves
  exercise('legs-001', 'Back Squat', 'upper legs', 'barbell', 'quads', ['glutes', 'hamstrings'], [
    'Rack the bar across the upper traps and step out.',
    'Squat to at least parallel with knees tracking over the toes.',
    'Drive up through mid-foot to lockout.',
  ]),
  exercise('legs-002', 'Front Squat', 'upper legs', 'barbell', 'quads', ['core', 'upper back'], [
    'Rack the bar in the front-rack position with high elbows.',
    'Descend with a vertical torso and full-depth knee bend.',
    'Drive up while keeping the elbows high.',
  ]),
  exercise('legs-003', 'Romanian Deadlift', 'upper legs', 'barbell', 'hamstrings', ['glutes', 'erectors'], [
    'Hold the bar at the hips with knees softly bent.',
    'Hinge at the hips, lowering the bar along the legs to mid-shin.',
    'Drive the hips through to stand tall.',
  ]),
  exercise('legs-004', 'Leg Press', 'upper legs', 'machine', 'quads', ['glutes', 'hamstrings'], [
    'Sit at a leg press with feet shoulder-width on the platform.',
    'Lower until the knees approach the chest under control.',
    'Press back without locking the knees fully.',
  ]),
  exercise('legs-005', 'Walking Lunge', 'upper legs', 'dumbbell', 'quads', ['glutes', 'hamstrings'], [
    'Hold a dumbbell in each hand at the sides.',
    'Step forward into a lunge until the back knee nearly touches the floor.',
    'Drive through the front heel to step into the next lunge.',
  ]),
  exercise('legs-006', 'Bulgarian Split Squat', 'upper legs', 'dumbbell', 'quads', ['glutes', 'hamstrings'], [
    'Place the rear foot on a bench behind you.',
    'Lower the back knee toward the floor with a vertical front shin.',
    'Drive through the front heel to stand.',
  ]),
  exercise('legs-007', 'Hip Thrust', 'upper legs', 'barbell', 'glutes', ['hamstrings'], [
    'Sit with the upper back on a bench and the bar across the hips.',
    'Drive the hips up until the body is parallel to the floor.',
    'Lower under control.',
  ]),
  exercise('legs-008', 'Leg Curl', 'upper legs', 'machine', 'hamstrings', [], [
    'Sit or lie at the leg curl machine with the pad above the heels.',
    'Curl the heels toward the glutes.',
    'Return under control.',
  ]),
  exercise('legs-009', 'Leg Extension', 'upper legs', 'machine', 'quads', [], [
    'Sit at the leg extension machine with the pad above the ankles.',
    'Extend the knees to lockout.',
    'Lower under control.',
  ]),
  exercise('legs-010', 'Standing Calf Raise', 'lower legs', 'machine', 'calves', [], [
    'Place the balls of the feet on the platform with the heels hanging.',
    'Press up onto the toes as high as possible.',
    'Lower under control to a full stretch.',
  ]),

  // Cardio
  exercise('cardio-001', 'Treadmill Run', 'cardio', 'machine', 'cardiovascular', [], [
    'Set a moderate pace appropriate to your conditioning.',
    'Run with a forward lean from the ankles and a relaxed upper body.',
    'Cool down at a walking pace for 2 to 5 minutes.',
  ]),
  exercise('cardio-002', 'Stationary Bike', 'cardio', 'machine', 'cardiovascular', [], [
    'Adjust seat height so the knee has a slight bend at the bottom of the stroke.',
    'Hold a steady cadence of 70 to 90 RPM at moderate resistance.',
    'Cool down with low resistance for the final minute.',
  ]),
  exercise('cardio-003', 'Rowing Machine', 'cardio', 'machine', 'cardiovascular', ['back', 'legs'], [
    'Strap the feet in and grip the handle.',
    'Drive the legs first, then hinge back, then pull the handle to the lower ribs.',
    'Reverse the sequence on the return.',
  ]),
  exercise('cardio-004', 'Jump Rope', 'cardio', 'rope', 'cardiovascular', ['calves'], [
    'Hold the handles loosely with the elbows close to the ribs.',
    'Bounce on the balls of the feet, turning the rope from the wrists.',
    'Aim for short, controlled hops rather than high jumps.',
  ]),
  exercise('cardio-005', 'Box Step Up', 'cardio', 'plyo box', 'cardiovascular', ['quads', 'glutes'], [
    'Stand in front of a sturdy box.',
    'Step one foot fully onto the box and stand tall.',
    'Step down under control and alternate legs.',
  ]),
  exercise('cardio-006', 'Burpee', 'cardio', 'body weight', 'cardiovascular', ['chest', 'legs'], [
    'From standing, drop the hands to the floor and kick the feet back.',
    'Perform a push-up, then jump the feet forward.',
    'Stand and finish with a small vertical jump.',
  ]),
  exercise('cardio-007', 'Mountain Climber', 'cardio', 'body weight', 'cardiovascular', ['core'], [
    'Set up in a tall plank position.',
    'Drive one knee toward the chest, then quickly switch.',
    'Maintain a flat back throughout.',
  ]),

  // Mobility
  exercise('mob-001', 'Cat Cow', 'mobility', 'body weight', 'spine', [], [
    'Set up on hands and knees with the wrists under the shoulders.',
    'Round the spine toward the ceiling on the exhale.',
    'Drop the belly and lift the gaze on the inhale.',
  ]),
  exercise('mob-002', 'World\'s Greatest Stretch', 'mobility', 'body weight', 'hips', ['thoracic'], [
    'Step into a deep lunge with the hands inside the front foot.',
    'Rotate the front-side arm up toward the ceiling.',
    'Return and switch sides each repetition.',
  ]),
  exercise('mob-003', 'Hip Flexor Stretch', 'mobility', 'body weight', 'hips', [], [
    'Drop into a half-kneeling lunge.',
    'Squeeze the rear glute and gently shift the hips forward.',
    'Hold for 30 seconds per side.',
  ]),
  exercise('mob-004', '90/90 Hip Switch', 'mobility', 'body weight', 'hips', [], [
    'Sit with one leg in front bent 90 degrees and the other behind also bent 90 degrees.',
    'Rotate the hips to switch sides under control.',
    'Keep the torso upright throughout.',
  ]),
  exercise('mob-005', 'Thoracic Rotation', 'mobility', 'body weight', 'thoracic', [], [
    'Set up on hands and knees with one hand behind the head.',
    'Rotate the elbow up toward the ceiling.',
    'Return and repeat for the prescribed reps before switching sides.',
  ]),
  exercise('mob-006', 'Wall Slide', 'mobility', 'body weight', 'shoulders', [], [
    'Stand with the back against a wall, arms in a goalpost.',
    'Slide the arms up the wall while keeping the wrists in contact.',
    'Lower under control.',
  ]),
  exercise('mob-007', 'Couch Stretch', 'mobility', 'body weight', 'hips', ['quads'], [
    'Place the rear shin on a couch or bench in a half-kneeling position.',
    'Squeeze the rear glute and bring the torso upright.',
    'Hold for 30 to 60 seconds per side.',
  ]),
  exercise('mob-008', 'Pigeon Pose', 'mobility', 'body weight', 'hips', ['glutes'], [
    'From hands and knees, bring one shin forward in front of the hips.',
    'Slide the other leg back keeping the hip square.',
    'Sink the hips down for 30 to 60 seconds per side.',
  ]),

  // Core
  exercise('core-001', 'Plank', 'core', 'body weight', 'core', [], [
    'Set up on the elbows with the body in a straight line.',
    'Squeeze the glutes and brace the abs.',
    'Hold without letting the hips drop.',
  ]),
  exercise('core-002', 'Hanging Knee Raise', 'core', 'body weight', 'core', ['hip flexors'], [
    'Hang from a bar with a controlled grip.',
    'Raise the knees toward the chest under control.',
    'Lower fully without swinging.',
  ]),
  exercise('core-003', 'Russian Twist', 'core', 'body weight', 'obliques', [], [
    'Sit with the knees bent and feet lifted.',
    'Rotate the torso side to side under control.',
    'Keep the spine long throughout.',
  ]),
  exercise('core-004', 'Dead Bug', 'core', 'body weight', 'core', [], [
    'Lie on the back with arms extended and knees over hips.',
    'Lower one arm and the opposite leg until just above the floor.',
    'Return and switch sides.',
  ]),
  exercise('core-005', 'Pallof Press', 'core', 'cable', 'obliques', ['core'], [
    'Stand sideways to a cable at chest height.',
    'Press the handle straight out from the chest, resisting rotation.',
    'Return slowly.',
  ]),
];

export interface SeedSearchParams {
  q?: string;
  muscleGroup?: string;
  equipment?: string;
  limit?: number;
  offset?: number;
}

export function searchSeed(params: SeedSearchParams): { items: Exercise[]; total: number } {
  const { q, muscleGroup, equipment, limit = 20, offset = 0 } = params;
  let items = SEED_EXERCISES;
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.target.toLowerCase().includes(needle) ||
        e.bodyPart.toLowerCase().includes(needle),
    );
  }
  if (muscleGroup) {
    const mg = muscleGroup.toLowerCase();
    items = items.filter(
      (e) => e.bodyPart.toLowerCase() === mg || e.target.toLowerCase() === mg,
    );
  }
  if (equipment) {
    const eq = equipment.toLowerCase();
    items = items.filter((e) => e.equipment.toLowerCase() === eq);
  }
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { items: page, total };
}

export function findSeedById(id: string): Exercise | null {
  return SEED_EXERCISES.find((e) => e.id === id) ?? null;
}
