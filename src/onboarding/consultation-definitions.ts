/**
 * Consultation screen definitions (contract consult-v1): question text and
 * option labels used to render the coach's read-only view of a client's
 * answers. Generated from the mobile consultation definitions
 * (growth-project-mobile src/lib/consultation/definitions.ts, PR #310) so the
 * coach sees the exact wording the client answered. Placeholders such as
 * {coach} are replaced with neutral text. Keep in sync when the mobile copy
 * changes (test/onboarding-consultation-view.spec.ts checks coverage).
 */

export interface OptionLabel {
  value: string;
  label: string;
}

export interface ScreenLabel {
  key: string;
  chapter: number;
  question: string;
  options?: OptionLabel[];
  detail_chips?: { key: string; label: string | null; options: OptionLabel[] };
  detail_text?: { key: string; label: string | null };
}

export const CHAPTER_TITLES: Readonly<Record<number, string>> = {
  1: 'Goals',
  2: 'Body basics',
  3: 'Lifestyle',
  4: 'Training',
  5: 'Schedule',
  6: 'Nutrition',
  7: 'Safety',
  8: 'Commitment',
};

export const CHAPTER_KEYS: Readonly<Record<number, string>> = {
  1: 'goals',
  2: 'body',
  3: 'lifestyle',
  4: 'training',
  5: 'schedule',
  6: 'nutrition',
  7: 'safety',
  8: 'commitment',
};

export const SCREEN_LABELS: readonly ScreenLabel[] = [
  {
    key: 'G1',
    chapter: 1,
    question: 'What would you most like from training right now?',
    options: [
      {
        value: 'fat_loss',
        label: 'Lose body fat',
      },
      {
        value: 'muscle_gain',
        label: 'Build muscle and strength',
      },
      {
        value: 'maintenance',
        label: 'Maintain and feel better',
      },
      {
        value: 'performance',
        label: 'Train for a sport or event',
      },
    ],
  },
  {
    key: 'G2',
    chapter: 1,
    question: 'And why does that matter to you?',
    options: [
      {
        value: 'energy',
        label: 'More energy day to day',
      },
      {
        value: 'strength',
        label: 'Feel stronger',
      },
      {
        value: 'confidence',
        label: 'Feel confident in my body',
      },
      {
        value: 'family',
        label: 'Keep up with family',
      },
      {
        value: 'event',
        label: 'An event is coming up',
      },
      {
        value: 'longevity',
        label: 'Stay active for the long run',
      },
      {
        value: 'other',
        label: 'Something else',
      },
    ],
    detail_text: {
      key: 'G2_other',
      label: 'In your words',
    },
  },
  {
    key: 'B1',
    chapter: 2,
    question: 'For your energy estimate, which formula should I use?',
    options: [
      {
        value: 'female',
        label: 'Female',
      },
      {
        value: 'male',
        label: 'Male',
      },
      {
        value: 'prefer_not_to_say',
        label: 'Prefer not to say',
      },
    ],
  },
  {
    key: 'B2',
    chapter: 2,
    question: 'When were you born?',
  },
  {
    key: 'B3',
    chapter: 2,
    question: 'Your height and weight.',
  },
  {
    key: 'B4',
    chapter: 2,
    question: 'Do you have a goal weight in mind?',
  },
  {
    key: 'L1',
    chapter: 3,
    question: 'Counting work, walking and exercise, how active is a typical week?',
    options: [
      {
        value: 'sedentary',
        label: 'Mostly sitting',
      },
      {
        value: 'light',
        label: 'Lightly active',
      },
      {
        value: 'moderate',
        label: 'Moderately active',
      },
      {
        value: 'active',
        label: 'Very active',
      },
      {
        value: 'very_active',
        label: 'Physically demanding',
      },
    ],
  },
  {
    key: 'L2',
    chapter: 3,
    question: 'How much do you usually sleep?',
    options: [
      {
        value: 'lt_6',
        label: 'Under 6 hours',
      },
      {
        value: '6_7',
        label: '6 to 7',
      },
      {
        value: '7_8',
        label: '7 to 8',
      },
      {
        value: 'gt_8',
        label: 'More than 8',
      },
    ],
  },
  {
    key: 'T1',
    chapter: 4,
    question: 'How familiar are you with structured training?',
    options: [
      {
        value: 'beginner',
        label: 'New to it',
      },
      {
        value: 'intermediate',
        label: 'Some experience',
      },
      {
        value: 'advanced',
        label: 'Experienced',
      },
    ],
  },
  {
    key: 'T2',
    chapter: 4,
    question: 'What have you enjoyed before?',
    options: [
      {
        value: 'weights',
        label: 'Weights',
      },
      {
        value: 'classes',
        label: 'Classes',
      },
      {
        value: 'running',
        label: 'Running',
      },
      {
        value: 'sports',
        label: 'Sports',
      },
      {
        value: 'yoga_pilates',
        label: 'Yoga or Pilates',
      },
      {
        value: 'home',
        label: 'Home workouts',
      },
      {
        value: 'swim_cycle',
        label: 'Swimming or cycling',
      },
      {
        value: 'none',
        label: 'Nothing yet',
      },
    ],
  },
  {
    key: 'T3',
    chapter: 4,
    question:
      'Is any part of your body asking for extra care right now? An injury, a sore joint, or a recent surgery.',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_chips: {
      key: 'T3_areas',
      label: 'Where?',
      options: [
        {
          value: 'lower_back',
          label: 'Lower back',
        },
        {
          value: 'upper_back_neck',
          label: 'Upper back or neck',
        },
        {
          value: 'shoulder',
          label: 'Shoulder',
        },
        {
          value: 'elbow_wrist',
          label: 'Elbow or wrist',
        },
        {
          value: 'hip',
          label: 'Hip',
        },
        {
          value: 'knee',
          label: 'Knee',
        },
        {
          value: 'ankle_foot',
          label: 'Ankle or foot',
        },
        {
          value: 'other',
          label: 'Other',
        },
      ],
    },
    detail_text: {
      key: 'T3_note',
      label: 'Anything your coach should know? (optional)',
    },
  },
  {
    key: 'T4',
    chapter: 4,
    question: 'How long can a typical session be?',
    options: [
      {
        value: '20_30',
        label: '20 to 30 min',
      },
      {
        value: '30_45',
        label: '30 to 45',
      },
      {
        value: '45_60',
        label: '45 to 60',
      },
      {
        value: '60_plus',
        label: 'Over an hour',
      },
    ],
  },
  {
    key: 'S1',
    chapter: 5,
    question: 'Realistically, how many days a week can you train?',
    options: [
      {
        value: '2',
        label: '1 to 2',
      },
      {
        value: '3',
        label: '3',
      },
      {
        value: '4',
        label: '4',
      },
      {
        value: '5',
        label: '5 or more',
      },
    ],
  },
  {
    key: 'S2',
    chapter: 5,
    question: 'When do you prefer to train?',
    options: [
      {
        value: 'morning',
        label: 'Morning',
      },
      {
        value: 'midday',
        label: 'Midday',
      },
      {
        value: 'evening',
        label: 'Evening',
      },
      {
        value: 'varies',
        label: 'It varies',
      },
    ],
  },
  {
    key: 'S3',
    chapter: 5,
    question: 'Where will you train most often?',
    options: [
      {
        value: 'gym',
        label: 'A gym',
      },
      {
        value: 'home_some',
        label: 'At home, with some equipment',
      },
      {
        value: 'none',
        label: 'At home or anywhere, no equipment',
      },
      {
        value: 'mix',
        label: 'A mix of gym and home',
      },
    ],
  },
  {
    key: 'S3b',
    chapter: 5,
    question: 'What do you have at home?',
    options: [
      {
        value: 'dumbbells',
        label: 'Dumbbells',
      },
      {
        value: 'kettlebells',
        label: 'Kettlebells',
      },
      {
        value: 'resistance_bands',
        label: 'Resistance bands',
      },
      {
        value: 'barbell',
        label: 'Barbell',
      },
      {
        value: 'pull_up_bar',
        label: 'Pull-up bar',
      },
      {
        value: 'cardio_machine',
        label: 'Cardio machine',
      },
      {
        value: 'other',
        label: 'Something else',
      },
    ],
  },
  {
    key: 'N1',
    chapter: 6,
    question: 'Do you follow a particular way of eating?',
    options: [
      {
        value: 'none',
        label: 'No particular pattern',
      },
      {
        value: 'vegetarian',
        label: 'Vegetarian',
      },
      {
        value: 'vegan',
        label: 'Vegan',
      },
      {
        value: 'pescatarian',
        label: 'Pescatarian',
      },
      {
        value: 'keto',
        label: 'Keto',
      },
      {
        value: 'paleo',
        label: 'Paleo',
      },
      {
        value: 'other',
        label: 'Something else',
      },
    ],
  },
  {
    key: 'N2',
    chapter: 6,
    question: "Anything you can't or won't eat?",
    options: [
      {
        value: 'nothing',
        label: 'Nothing',
      },
      {
        value: 'dairy',
        label: 'Dairy',
      },
      {
        value: 'gluten',
        label: 'Gluten',
      },
      {
        value: 'nuts',
        label: 'Nuts',
      },
      {
        value: 'shellfish',
        label: 'Shellfish',
      },
      {
        value: 'eggs',
        label: 'Eggs',
      },
      {
        value: 'soy',
        label: 'Soy',
      },
      {
        value: 'pork',
        label: 'Pork',
      },
      {
        value: 'halal',
        label: 'Halal only',
      },
      {
        value: 'kosher',
        label: 'Kosher only',
      },
      {
        value: 'other',
        label: 'Something else',
      },
    ],
    detail_text: {
      key: 'N2_other',
      label: 'What else?',
    },
  },
  {
    key: 'N3',
    chapter: 6,
    question: 'How many times do you usually eat in a day?',
    options: [
      {
        value: '2',
        label: '2',
      },
      {
        value: '3',
        label: '3',
      },
      {
        value: '4',
        label: '4',
      },
      {
        value: '5',
        label: '5 or more',
      },
    ],
  },
  {
    key: 'N4',
    chapter: 6,
    question: 'Have you tracked food before?',
    options: [
      {
        value: 'never',
        label: 'Never',
      },
      {
        value: 'some',
        label: 'A little',
      },
      {
        value: 'regular',
        label: 'Regularly',
      },
    ],
  },
  {
    key: 'N5',
    chapter: 6,
    question: 'What makes eating well hardest for you?',
    options: [
      {
        value: 'time',
        label: 'Time',
      },
      {
        value: 'cravings',
        label: 'Cravings',
      },
      {
        value: 'eating_out',
        label: 'Eating out',
      },
      {
        value: 'late_nights',
        label: 'Late nights',
      },
      {
        value: 'not_sure',
        label: 'Not sure what to eat',
      },
      {
        value: 'other',
        label: 'Something else',
      },
    ],
  },
  {
    key: 'P0',
    chapter: 7,
    question: 'Before we get started',
  },
  {
    key: 'P1',
    chapter: 7,
    question:
      'Has a doctor ever told you that you have a heart condition, or that you should only do physical activity recommended by a doctor?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P1_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'P2',
    chapter: 7,
    question:
      'Do you feel pain or discomfort in your chest during physical activity, or have you in the past month?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P2_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'P3',
    chapter: 7,
    question:
      'Have you lost your balance because of dizziness, or lost consciousness, in the last 12 months?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P3_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'P4',
    chapter: 7,
    question:
      'Do you have a bone, joint, or soft-tissue problem (for example, back, knee, hip, or shoulder) that could get worse with exercise?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P4_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'P5',
    chapter: 7,
    question:
      'Is a doctor currently prescribing you medication for blood pressure or a heart condition?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P5_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'P6',
    chapter: 7,
    question: 'Are you currently pregnant, or have you given birth in the last 6 months?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P6_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'P7',
    chapter: 7,
    question:
      'Is there any other reason, such as an injury, a surgery, or a chronic condition, that makes you concerned about starting an exercise program?',
    options: [
      {
        value: 'no',
        label: 'No',
      },
      {
        value: 'yes',
        label: 'Yes',
      },
    ],
    detail_text: {
      key: 'P7_note',
      label: 'Tell your coach more (optional)',
    },
  },
  {
    key: 'C1',
    chapter: 8,
    question: 'When will you do your first session?',
  },
];
