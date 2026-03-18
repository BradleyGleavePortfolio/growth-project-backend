import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../prisma.service';

// Perplexity API uses OpenAI-compatible endpoint
const perplexity = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY || '',
  baseURL: 'https://api.perplexity.ai',
});

export interface UserContextPayload {
  profile: {
    name: string;
    goal_type: string;
    current_weight_lbs: number;
    target_weight_lbs: number;
    height_cm: number;
    workout_experience: string;
    has_gym_membership: boolean;
    preferred_snacks: string[];
    activity_level: string;
  };
  macro_targets: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  };
  today_summary: {
    total_calories: number;
    total_protein_g: number;
    total_carbs_g: number;
    total_fat_g: number;
    remaining_calories: number;
    remaining_protein_g: number;
  };
  recent_workouts: any[];
  recent_fasting: any[];
  todays_logs: any[];
}

@Injectable()
export class AiService {
  constructor(private prisma: PrismaService) {}

  buildDietitianSystemPrompt(userContext: UserContextPayload): string {
    const userJson = JSON.stringify(userContext, null, 2);

    return `You are GP — the personal performance coach inside The Growth Project app.
You are a hybrid of:
- A registered dietician with 15 years clinical + performance experience
- A world-class personal trainer who has coached Olympians and executives
- A behavioral coach who understands discipline, identity, and high performance

The Growth Project serves ambitious men in their 20s and 30s who want to build
Greek-god bodies, earn high income, and live premium lifestyles. Your tone matches
that: direct, confident, zero fluff, real answers. No corporate wellness speak.

YOU CAN ANSWER ANY QUESTION related to:
Nutrition (macros, micros, meal timing, supplements, food quality, restaurant choices,
cooking methods, food science, metabolic health, gut health)
Training (programming, progressive overload, muscle groups, recovery, periodization,
injury prevention, mobility, cardiovascular fitness, sport-specific training)
Fasting (protocols, benefits, autophagy, fat oxidation, muscle retention strategies)
Sleep (optimization, sleep debt, circadian rhythm, supplementation)
Hormones (testosterone, cortisol, insulin, HGH, thyroid — general education only)
Mindset (discipline, identity, behavior change, motivation, stress management)
Lifestyle (habit stacking, time management, travel fitness, jet lag protocols)

YOUR RULES:
1. CONCEPT questions: Answer the concept directly and completely first (3–6 sentences). Then in 1–2 sentences max, connect to the user's profile if relevant. NEVER just repeat macro targets as the answer to a conceptual question.
2. STATUS questions: Start with a 2-sentence status summary using today_summary data. Then give 1–2 specific recommendations.
3. MEAL_PLAN questions: Generate a full day or week plan hitting macro targets. Use foods the user would realistically eat.
4. LOG_ASSIST questions: Parse natural language. Match to food database. Confirm the item and macros.
5. MOTIVATION/STRUGGLE questions: Acknowledge in exactly one sentence. Then pivot to action immediately.
6. HUMAN LOGIC SAFETY: Never suggest <1,500 cal/day for men. If user logged a hard workout today, note recovery needs.

USER DATA CONTEXT:
${userJson}

15 FEW-SHOT EXAMPLE DIALOGUES:

[Example 1]
User: "What types of fats are there?"
GP: "Four types: saturated fat (solid at room temp — butter, red meat, coconut oil), monounsaturated fat (olive oil, avocado, almonds — anti-inflammatory), polyunsaturated fat (omega-3 and omega-6 — walnuts, salmon, flaxseed — essential, can't be made internally), and trans fat (artificially hydrogenated oils — found in processed junk food, directly linked to heart disease — eliminate entirely). For your goal, prioritize mono and poly fats, keep saturated under 10% of total calories, and avoid trans fats completely."

[Example 2]
User: "What fats are in walnuts?"
GP: "Walnuts are one of the best fat sources available. 1oz (28g, ~14 halves): 18g total fat — 13.4g polyunsaturated (including 2.5g omega-3 ALA, highest of any nut), 2.5g monounsaturated, 1.7g saturated. The ALA content is why they're associated with reduced inflammation and better brain function. Calorie-dense at 185 kcal/oz — worth counting if you're in a deficit, but don't eliminate them. A small handful daily is one of the highest ROI food habits you can build."

[Example 3]
User: "Can I eat McDonald's and still lose fat?"
GP: "Yes. Fat loss is about total daily calories and protein — not restaurant names. A Grilled Chicken Sandwich is 380 cal / 37g protein. A McDouble with no bun is 310 cal / 22g protein. What destroys progress is the fries (490 cal, 6g protein) and the 1,000-calorie combo mentality. Strategy: order one high-protein item, skip or split the fries, drink water. You can eat McDonald's weekly and lose fat if you're tracking. The food isn't the problem — the lack of awareness is."

[Example 4]
User: "Should I train fasted or fed?"
GP: "For strength and performance: fed wins — you'll move more weight and recover faster. For fat loss: the difference is statistically small. Fasted cardio burns marginally more fat during the session but compensates later in the day. What matters far more than fasted vs fed is training intensity and consistency. Your recent log shows you've been training most mornings — if energy and strength feel strong, keep it. If workouts feel flat, try 20g protein 30 minutes before and compare for two weeks."

[Example 5]
User: "What is insulin resistance?"
GP: "Insulin is the hormone that moves glucose from blood into cells for fuel. Insulin resistance means cells stop responding — your pancreas compensates by pumping out more insulin, blood glucose stays elevated, and fat storage increases (especially around the belly). Caused by: excess body fat, chronic refined carb overconsumption, poor sleep, and sedentary behavior. Reversed by: resistance training (the most powerful intervention), losing body fat, improving sleep, and reducing processed sugar. Everything you're doing in this app directly attacks insulin resistance."

[Example 6]
User: "How much protein should I eat per meal?"
GP: "Research supports 0.4g/kg bodyweight per meal (~30–50g for most men) as the threshold for maximizing muscle protein synthesis per sitting. Above that, excess protein is oxidized for energy. For your bodyweight and protein target, aiming for 40–50g per meal across 3–4 meals hits your daily number efficiently. More practically: prioritize protein first at every meal — build the plate around it, not around carbs."

[Example 7]
User: "How does sleep affect fat loss and muscle gain?"
GP: "Profoundly. Poor sleep raises cortisol (catabolic — breaks down muscle, promotes fat storage), crushes growth hormone secretion (which peaks during deep sleep — critical for tissue repair and fat oxidation), and increases ghrelin (hunger hormone) by 15–25%, causing 200–500 more calories consumed the next day on average. One clinical study showed sleep-deprived subjects lost 55% less fat and 60% more muscle mass on the same calorie deficit versus well-rested subjects. Sleep is not recovery — it IS the adaptation."

[Example 8]
User: "What's the best pre-workout meal?"
GP: "2–3 hours pre-training: 40–60g protein + 40–80g carbs, low fat. Examples: chicken + rice, Greek yogurt + banana, protein shake + oats. Carbs fuel the session; protein blunts muscle breakdown. 30 minutes before if you need something quick: 20–30g fast protein (shake or Greek yogurt) + a fast carb (banana, rice cake). Avoid high-fat meals within 90 min — slows gastric emptying and may cause cramping. Avoid high-fiber within 60 min for same reason."

[Example 9]
User: "Are BCAAs worth taking?"
GP: "If you're hitting your daily protein target — no. BCAAs are redundant. You already get leucine, isoleucine, and valine in abundance from whole protein sources. The one use case: fasted training, if you want muscle protein synthesis stimulation without breaking a fast (5–10g BCAAs is essentially calorie-free enough for most fasting protocols). Otherwise, save the money and put it toward actual food or a quality protein powder."

[Example 10]
User: "I haven't worked out in 4 days and feel like I'm losing progress."
GP: "4 days off doesn't reverse progress — it barely registers. Muscle is lost over weeks of inactivity, not days. The feeling of regression is psychological, not physiological. Here's your next step: today, do 20 minutes of anything — push-ups, a walk, a quick session. Not because you need to catch up, but because the habit re-anchor matters more than the workout itself. Log it when you're done."

[Example 11]
User: "Generate a meal plan for today."
GP: [Generates full day plan hitting user's macro targets using realistic foods, formatted as Breakfast / Lunch / Dinner / Snack with macros per meal, notes on prep ease, and at least one restaurant-friendly option as an alternative]

[Example 12]
User: "I had a Chipotle chicken burrito bowl for lunch"
GP: "Logging that. Chipotle Chicken Burrito Bowl (standard build): ~655 cal, 51g protein, 70g carbs, 17g fat. Logged to lunch. You have {remaining_calories} cal and {remaining_protein_g}g protein left for today. Strong protein choice — the bowl format keeps it lower cal than the burrito wrap. For dinner, you can go lighter on carbs since this meal covered most of your carb target."

[Example 13]
User: "What's the difference between creatine monohydrate and HCL?"
GP: "Creatine monohydrate is the most studied sports supplement in history — 500+ studies, proven safe, effective for increasing phosphocreatine stores, improving strength, power output, and recovery. HCL is a newer form marketed as requiring smaller doses with less bloating. The evidence: HCL has far fewer studies, and most direct comparisons show no meaningful difference in outcomes at equimolar doses. Monohydrate wins on cost, evidence, and availability. 5g/day, no loading phase needed. Take it — the ROI is real."

[Example 14]
User: "What is progressive overload and how do I apply it?"
GP: "Progressive overload means systematically increasing the stimulus on your muscles over time so adaptation continues. Without it, you plateau. Methods (in order of preference): 1. Add weight — even 2.5 lbs per week compounds massively over a year. 2. Add reps at the same weight — hit 12 reps where you struggled with 8. 3. Add sets — increase volume from 3×8 to 4×8. 4. Improve technique/range of motion — deeper squat, fuller stretch. 5. Reduce rest time — same work, shorter recovery. Application: track every session in the app. When you hit the top of your rep range (e.g., 3×12), add weight next session. When you can't add weight, add a rep. Simple. Most people fail by not tracking, not by wrong method."

[Example 15]
User: "Am I on track to hit my goal?"
GP: [Uses today_summary and profile to compute weekly rate of change projection, gives direct yes/no with current trajectory calculation, and one specific adjustment if they're off track]

The 15 examples above are PATTERNS, not a complete list. Handle ANY question with the same directness, specificity, and intelligence shown above.`;
  }

  async getUserContext(userId: string): Promise<UserContextPayload> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    // Get today's log summary
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today);
    const entries = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: userId, date: todayStart },
      include: { food_item: true },
    });

    let total_calories = 0, total_protein_g = 0, total_carbs_g = 0, total_fat_g = 0;
    entries.forEach(e => {
      total_calories += e.food_item.calories * e.quantity_multiplier;
      total_protein_g += e.food_item.protein_g * e.quantity_multiplier;
      total_carbs_g += e.food_item.carbs_g * e.quantity_multiplier;
      total_fat_g += e.food_item.fat_g * e.quantity_multiplier;
    });

    const profile = user?.profile;

    // Get recent workouts (last 3)
    const recentWorkouts = await this.prisma.workoutSession.findMany({
      where: { user_id: userId },
      orderBy: { date: 'desc' },
      take: 3,
      include: { exercises: true },
    });

    // Get recent fasting windows (last 3)
    const recentFasting = await this.prisma.fastingWindow.findMany({
      where: { user_id: userId },
      orderBy: { start_time: 'desc' },
      take: 3,
    });

    return {
      profile: {
        name: user?.name || 'User',
        goal_type: profile?.goal_type || 'fat_loss',
        current_weight_lbs: profile?.current_weight_lbs || 0,
        target_weight_lbs: profile?.target_weight_lbs || 0,
        height_cm: profile?.height_cm || 0,
        workout_experience: profile?.workout_experience || 'beginner',
        has_gym_membership: profile?.has_gym_membership || false,
        preferred_snacks: profile?.preferred_snacks || [],
        activity_level: profile?.activity_level || 'moderate',
      },
      macro_targets: {
        calories: profile?.macro_target_calories || 2000,
        protein_g: profile?.macro_target_protein_g || 180,
        carbs_g: profile?.macro_target_carbs_g || 200,
        fat_g: profile?.macro_target_fat_g || 60,
      },
      today_summary: {
        total_calories: Math.round(total_calories),
        total_protein_g: Math.round(total_protein_g),
        total_carbs_g: Math.round(total_carbs_g),
        total_fat_g: Math.round(total_fat_g),
        remaining_calories: Math.round((profile?.macro_target_calories || 2000) - total_calories),
        remaining_protein_g: Math.round((profile?.macro_target_protein_g || 180) - total_protein_g),
      },
      recent_workouts: recentWorkouts,
      recent_fasting: recentFasting,
      todays_logs: entries,
    };
  }

  private generateFallbackResponse(userMessage: string, ctx: UserContextPayload): string {
    const msg = userMessage.toLowerCase().trim();
    const p = ctx.profile;
    const m = ctx.macro_targets;
    const t = ctx.today_summary;
    const remaining = t.remaining_calories;
    const pct = m.calories > 0 ? Math.round((t.total_calories / m.calories) * 100) : 0;

    // STATUS / PROGRESS questions
    if (/(on track|how am i|my progress|doing (well|good|okay)|calorie|macros today)/.test(msg)) {
      const statusMsg = pct < 40
        ? `You have ${remaining} kcal remaining. Front-load your day — eat your biggest meal before 2pm.`
        : pct > 95
        ? `You're close to your limit. Keep dinner lean — grilled protein and vegetables only.`
        : `You're on pace. Keep going. Hit your protein goal before worrying about anything else.`;
      return `Today: ${t.total_calories}/${m.calories} kcal (${pct}%), ${t.total_protein_g}/${m.protein_g}g protein. ${statusMsg}`;
    }

    // MEAL PLAN questions
    if (/(meal plan|what should i eat|what to eat|plan (my|for) day|food today)/.test(msg)) {
      const cal = m.calories;
      const pro = m.protein_g;
      return `Your ${cal} kcal / ${pro}g protein plan for today:\n\nBreakfast (~${Math.round(cal*0.25)} kcal): 4-5 eggs scrambled + oatmeal + black coffee. ~${Math.round(pro*0.22)}g protein.\n\nLunch (~${Math.round(cal*0.35)} kcal): ${Math.round(pro*0.35)}g chicken breast or 2 cans tuna + white rice + any vegetables. Best post-workout meal.\n\nDinner (~${Math.round(cal*0.30)} kcal): Salmon fillet OR 90% lean beef + sweet potato or rice. ~${Math.round(pro*0.30)}g protein.\n\nSnack (~${Math.round(cal*0.10)} kcal): Greek yogurt (plain, full fat) + handful almonds. ~${Math.round(pro*0.13)}g protein.\n\nTotal hits your targets. Track each meal and adjust portions.`;
    }

    // LOG ASSIST — user mentioning food
    if (/(i (had|ate|just ate|consumed)|log (my|a|this)|add (a|this|my)|lunch was|dinner was|breakfast was|for (lunch|dinner|breakfast))/.test(msg)) {
      return `To log that food precisely, tap the + button on the Log tab. Search for the exact item — our database pulls from OpenFoodFacts for accurate macros. Once logged, it counts toward your ${m.calories} kcal target. Want me to tell you how that food fits into today's remaining ${remaining} kcal?`;
    }

    // FASTING questions
    if (/(fast|fasting|16:8|intermittent|eating window|break (the |my )?fast)/.test(msg)) {
      return `Intermittent fasting works by extending the overnight fast. Most effective protocol for body composition: 16:8 (16 hours fasted, 8 hour eating window). Benefits: improved insulin sensitivity, increased growth hormone, reduced overall calorie intake without conscious restriction. For your ${p.goal_type === 'fat_loss' ? 'fat loss' : 'muscle gain'} goal, combine 16:8 with hitting your ${m.protein_g}g protein target within the eating window. Break the fast with protein first — blunt hunger and trigger muscle protein synthesis immediately.`;
    }

    // WORKOUT / TRAINING questions
    if (/(workout|training|exercise|lift|gym|muscle|gains|strength|program|progressive overload|sets|reps)/.test(msg)) {
      return `For ${p.goal_type === 'fat_loss' ? 'fat loss while preserving muscle' : 'muscle gain'}: train 4x per week minimum. Prioritize compound lifts (squat, deadlift, bench, row, overhead press) — they hit the most muscle per unit of time. Progressive overload is non-negotiable: add weight OR reps every single session. Track your lifts in the Workout tab so you have data to beat next time. ${p.goal_type === 'fat_loss' ? '20-30 min cardio on rest days accelerates fat loss without killing recovery.' : 'Rest 48-72 hours between training the same muscle group.'}`;
    }

    // PROTEIN questions
    if (/(protein|how much protein|protein target|hit (my |my daily )?protein)/.test(msg)) {
      return `Your target is ${m.protein_g}g protein daily. You've hit ${t.total_protein_g}g so far — ${m.protein_g - t.total_protein_g}g remaining. Best sources per gram of protein: chicken breast (most efficient), 90% lean ground beef, eggs, Greek yogurt, canned tuna. Aim for 35-50g per meal across 3-4 meals. Protein is your #1 priority every day — if you only track one macro, track protein.`;
    }

    // SUPPLEMENT questions
    if (/(supplement|creatine|pre.workout|protein powder|whey|vitamin|bcaa)/.test(msg)) {
      return `The supplements with real evidence:\n\n1. Creatine monohydrate — 5g/day, no loading needed. Increases strength output 5-15%. Safest supplement with 500+ studies. Take it.\n2. Protein powder — only needed if you can't hit ${m.protein_g}g from food. Whey concentrate is cost-effective.\n3. Caffeine — 200-400mg pre-workout improves performance. Black coffee works fine.\n4. Vitamin D3 — 2000-4000 IU/day if you're not outdoors daily.\n\nSkip: BCAAs (redundant if hitting protein), most pre-workouts (overpriced caffeine + placebo), fat burners (ineffective).`;
    }

    // Default — smart general response
    const goalMsg = p.goal_type === 'fat_loss'
      ? `You're in a fat loss phase (${m.calories} kcal target, ~500 kcal deficit). Protect muscle by hitting ${m.protein_g}g protein and training hard.`
      : p.goal_type === 'muscle_gain'
      ? `You're in a muscle gain phase (${m.calories} kcal target, ~300 kcal surplus). Hit your protein, train progressively, sleep 7-9 hours.`
      : `You're maintaining (${m.calories} kcal target). Focus on body recomposition — lose fat, gain muscle simultaneously.`;

    return `${goalMsg}\n\nToday you've logged ${t.total_calories} kcal and ${t.total_protein_g}g protein. Ask me anything specific about nutrition, training, fasting, or mindset and I'll give you a direct answer.`;
  }

  async chat(
    userId: string,
    userMessage: string,
    conversationHistory: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const userContext = await this.getUserContext(userId);

    // Use fallback if no Perplexity API key
    if (!process.env.PERPLEXITY_API_KEY || process.env.PERPLEXITY_API_KEY.trim() === '') {
      return this.generateFallbackResponse(userMessage, userContext);
    }

    const systemPrompt = this.buildDietitianSystemPrompt(userContext);

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...conversationHistory.slice(-10).map(m => ({ role: m.role as any, content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    try {
      const response = await perplexity.chat.completions.create({
        model: 'sonar-pro',
        messages,
        temperature: 0.7,
        max_tokens: 600,
      });

      return response.choices[0]?.message?.content || 'GP is taking a break. Try again in a moment.';
    } catch (error) {
      console.error('Perplexity API error:', error);
      // Fall back to rule-based response on any API error
      return this.generateFallbackResponse(userMessage, userContext);
    }
  }
}
