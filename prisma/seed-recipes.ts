/**
 * One-shot seed script: creates 10 sample recipes tied to the first coach user
 * found in the database (or the first user if no coach exists).
 *
 * Run via Fly SSH:
 *   /home/user/.fly/bin/flyctl ssh console -a backend-spring-lake-3890 \
 *     --command "cd /app && node -e \"$(cat prisma/seed-recipes-compiled.js)\""
 *
 * Or locally after prisma generate:
 *   npx ts-node prisma/seed-recipes.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SAMPLE_RECIPES = [
  {
    title: 'High-Protein Chicken & Rice Bowl',
    description: 'A classic meal-prep staple packed with lean protein and complex carbs.',
    prep_time_min: 10,
    cook_time_min: 25,
    servings: 4,
    calories: 480,
    protein: 45,
    carbs: 52,
    fat: 8,
    tags: ['high-protein', 'meal-prep', 'lunch', 'dinner'],
    ingredients: [
      '600g chicken breast, cubed',
      '2 cups jasmine rice (dry)',
      '1 tbsp olive oil',
      '1 tsp garlic powder',
      '1 tsp paprika',
      'Salt & pepper to taste',
      '2 cups broccoli florets',
      '2 tbsp low-sodium soy sauce',
    ],
    instructions: [
      'Cook rice according to package directions.',
      'Season chicken with garlic powder, paprika, salt, and pepper.',
      'Heat olive oil in a large pan over medium-high heat.',
      'Cook chicken 6–8 minutes until golden and cooked through.',
      'Steam broccoli for 4 minutes until tender-crisp.',
      'Toss chicken with soy sauce and serve over rice with broccoli.',
    ],
  },
  {
    title: 'Greek Yogurt Parfait',
    description: 'A quick high-protein breakfast loaded with antioxidants.',
    prep_time_min: 5,
    cook_time_min: 0,
    servings: 1,
    calories: 320,
    protein: 24,
    carbs: 38,
    fat: 5,
    tags: ['breakfast', 'no-cook', 'high-protein', 'quick'],
    ingredients: [
      '1 cup plain Greek yogurt (0% fat)',
      '1/2 cup mixed berries',
      '2 tbsp granola',
      '1 tbsp honey',
      '1 tbsp chia seeds',
    ],
    instructions: [
      'Layer Greek yogurt in a bowl or jar.',
      'Top with mixed berries and granola.',
      'Drizzle with honey and sprinkle chia seeds.',
      'Serve immediately or refrigerate overnight.',
    ],
  },
  {
    title: 'Salmon & Avocado Power Bowl',
    description: 'Omega-3 rich salmon with healthy fats and greens.',
    prep_time_min: 10,
    cook_time_min: 15,
    servings: 2,
    calories: 520,
    protein: 38,
    carbs: 30,
    fat: 24,
    tags: ['high-protein', 'healthy-fats', 'lunch', 'dinner', 'gluten-free'],
    ingredients: [
      '2 salmon fillets (150g each)',
      '1 ripe avocado, sliced',
      '2 cups mixed greens',
      '1 cup cooked quinoa',
      '1 lemon, juiced',
      '1 tbsp olive oil',
      'Salt, pepper, dill to taste',
    ],
    instructions: [
      'Season salmon with salt, pepper, and dill.',
      'Heat olive oil in a pan over medium-high heat.',
      'Cook salmon 4 minutes per side until cooked through.',
      'Divide quinoa and greens between two bowls.',
      'Top with salmon and avocado slices.',
      'Drizzle with lemon juice and serve.',
    ],
  },
  {
    title: 'Turkey & Veggie Stir-Fry',
    description: 'Lean turkey with colorful vegetables — great macro split.',
    prep_time_min: 15,
    cook_time_min: 15,
    servings: 3,
    calories: 350,
    protein: 35,
    carbs: 25,
    fat: 10,
    tags: ['high-protein', 'low-carb', 'dinner', 'meal-prep'],
    ingredients: [
      '450g ground turkey',
      '1 cup bell peppers, sliced',
      '1 cup snap peas',
      '1 cup broccoli florets',
      '3 cloves garlic, minced',
      '2 tbsp soy sauce',
      '1 tbsp sesame oil',
      '1 tsp ginger, grated',
    ],
    instructions: [
      'Brown ground turkey in a wok over high heat. Drain excess fat.',
      'Add garlic and ginger, cook 1 minute.',
      'Add vegetables and stir-fry 4–5 minutes until tender-crisp.',
      'Add soy sauce and sesame oil, toss to coat.',
      'Serve over rice or eat as-is for low-carb option.',
    ],
  },
  {
    title: 'Overnight Oats',
    description: 'Prep the night before for a ready-to-go high-fiber breakfast.',
    prep_time_min: 5,
    cook_time_min: 0,
    servings: 1,
    calories: 390,
    protein: 20,
    carbs: 55,
    fat: 8,
    tags: ['breakfast', 'meal-prep', 'no-cook', 'high-fiber'],
    ingredients: [
      '1/2 cup rolled oats',
      '1/2 cup milk (dairy or plant-based)',
      '1/2 cup Greek yogurt',
      '1 tbsp chia seeds',
      '1 tbsp maple syrup',
      '1/2 banana, sliced',
      '1 tbsp almond butter',
    ],
    instructions: [
      'Combine oats, milk, yogurt, chia seeds, and maple syrup in a jar.',
      'Stir until well combined.',
      'Cover and refrigerate overnight (at least 6 hours).',
      'In the morning, top with banana slices and almond butter.',
    ],
  },
  {
    title: 'Egg & Veggie Scramble',
    description: 'Fast, filling breakfast with complete protein and micronutrients.',
    prep_time_min: 5,
    cook_time_min: 8,
    servings: 1,
    calories: 310,
    protein: 26,
    carbs: 12,
    fat: 18,
    tags: ['breakfast', 'high-protein', 'low-carb', 'quick', 'gluten-free'],
    ingredients: [
      '3 large eggs',
      '1/4 cup diced bell pepper',
      '1/4 cup diced onion',
      '1 cup baby spinach',
      '1 tbsp feta cheese',
      '1 tsp olive oil',
      'Salt, pepper, oregano to taste',
    ],
    instructions: [
      'Heat olive oil in a non-stick pan over medium heat.',
      'Sauté onion and bell pepper 3 minutes until softened.',
      'Add spinach and cook until wilted, about 1 minute.',
      'Beat eggs with salt, pepper, and oregano, pour into pan.',
      'Scramble gently until just set.',
      'Top with feta cheese and serve.',
    ],
  },
  {
    title: 'Tuna Lettuce Wraps',
    description: 'Ultra-low-carb, high-protein lunch ready in minutes.',
    prep_time_min: 8,
    cook_time_min: 0,
    servings: 2,
    calories: 210,
    protein: 30,
    carbs: 6,
    fat: 7,
    tags: ['lunch', 'low-carb', 'high-protein', 'no-cook', 'quick'],
    ingredients: [
      '2 cans tuna (in water, drained)',
      '2 tbsp light mayo',
      '1 tbsp Dijon mustard',
      '2 stalks celery, diced',
      '2 tbsp red onion, diced',
      '8 large romaine lettuce leaves',
      'Salt, pepper, lemon juice to taste',
    ],
    instructions: [
      'Drain tuna and flake into a bowl.',
      'Mix in mayo, mustard, celery, red onion, salt, pepper, and lemon juice.',
      'Spoon tuna mixture into lettuce leaves.',
      'Roll up and serve immediately.',
    ],
  },
  {
    title: 'Sweet Potato & Black Bean Bowl',
    description: 'Vegan-friendly macro-balanced bowl with plant-based protein.',
    prep_time_min: 10,
    cook_time_min: 30,
    servings: 3,
    calories: 420,
    protein: 18,
    carbs: 72,
    fat: 6,
    tags: ['vegan', 'plant-based', 'lunch', 'dinner', 'meal-prep', 'high-fiber'],
    ingredients: [
      '2 medium sweet potatoes, cubed',
      '1 can black beans, rinsed',
      '1 cup corn kernels',
      '1 red bell pepper, diced',
      '1/4 cup red onion, diced',
      '2 tbsp olive oil',
      '1 tsp cumin',
      '1 tsp smoked paprika',
      '1 lime, juiced',
      '2 tbsp fresh cilantro',
    ],
    instructions: [
      'Preheat oven to 220°C (425°F).',
      'Toss sweet potato with 1 tbsp olive oil, cumin, and paprika.',
      'Roast 25–30 minutes until caramelized.',
      'In a bowl combine beans, corn, pepper, and onion.',
      'Add roasted sweet potato.',
      'Drizzle with remaining olive oil and lime juice, toss.',
      'Garnish with cilantro and serve.',
    ],
  },
  {
    title: 'Protein Smoothie Bowl',
    description: 'Thick smoothie base loaded with protein for post-workout recovery.',
    prep_time_min: 7,
    cook_time_min: 0,
    servings: 1,
    calories: 440,
    protein: 38,
    carbs: 48,
    fat: 9,
    tags: ['breakfast', 'post-workout', 'high-protein', 'no-cook', 'quick'],
    ingredients: [
      '1 scoop vanilla protein powder',
      '1 frozen banana',
      '1/2 cup frozen mixed berries',
      '1/2 cup Greek yogurt',
      '1/4 cup milk',
      '2 tbsp granola (topping)',
      '1 tbsp almond butter (topping)',
      '1/4 cup fresh berries (topping)',
    ],
    instructions: [
      'Blend protein powder, frozen banana, frozen berries, yogurt, and milk until thick.',
      'Add more milk 1 tbsp at a time if too thick to blend.',
      'Pour into a bowl.',
      'Top with granola, almond butter, and fresh berries.',
      'Serve immediately.',
    ],
  },
  {
    title: 'Lean Beef Tacos',
    description: 'High-protein tacos with seasoned 90/10 ground beef.',
    prep_time_min: 10,
    cook_time_min: 15,
    servings: 4,
    calories: 380,
    protein: 32,
    carbs: 28,
    fat: 14,
    tags: ['dinner', 'high-protein', 'family-friendly'],
    ingredients: [
      '500g lean ground beef (90/10)',
      '8 small corn tortillas',
      '1 packet low-sodium taco seasoning',
      '1/3 cup water',
      '1 cup shredded lettuce',
      '1/2 cup diced tomato',
      '1/4 cup diced onion',
      '1/4 cup light sour cream',
      '1/2 cup salsa',
    ],
    instructions: [
      'Brown ground beef in a pan over medium-high heat. Drain excess fat.',
      'Add taco seasoning and water, stir to combine.',
      'Simmer 3–4 minutes until sauce thickens.',
      'Warm tortillas in a dry pan or microwave.',
      'Assemble tacos with beef, lettuce, tomato, onion, sour cream, and salsa.',
    ],
  },
];

async function main() {
  console.log('Seeding sample recipes...');

  // Find a coach user or fall back to the first user.
  let seedUser = await prisma.user.findFirst({
    where: { role: 'coach' },
    select: { id: true, name: true },
  });

  if (!seedUser) {
    seedUser = await prisma.user.findFirst({ select: { id: true, name: true } });
  }

  if (!seedUser) {
    console.error('No users found in DB. Register a user first.');
    process.exit(1);
  }

  console.log(`Seeding as: ${seedUser.name} (${seedUser.id})`);

  let created = 0;
  let skipped = 0;

  for (const recipe of SAMPLE_RECIPES) {
    const existing = await prisma.recipe.findFirst({
      where: { title: recipe.title, created_by_id: seedUser.id },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.recipe.create({
      data: { ...recipe, is_public: true, created_by_id: seedUser.id },
    });
    created++;
    console.log(`  ✓ ${recipe.title}`);
  }

  const total = await prisma.recipe.count();
  console.log(`\nDone. Created: ${created}, Skipped (already exist): ${skipped}`);
  console.log(`Total recipes in DB: ${total}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
