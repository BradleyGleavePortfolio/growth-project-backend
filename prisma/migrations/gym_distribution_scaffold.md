# Gym Distribution — Schema Scaffold

## New models required:

model GymProfile {
  id               String   @id @default(cuid())
  head_coach_id    String   @unique
  slug             String   @unique   // e.g. "equinox-downtown" for growthproject.app/join/equinox-downtown
  distribution_mode  DistributionMode @default(ROUND_ROBIN)
  round_robin_cursor Int     @default(0)  // index into sorted sub-coach list
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt
  weights          CoachDistributionWeight[]
}

enum DistributionMode {
  ROUND_ROBIN
  WEIGHTED
}

model CoachDistributionWeight {
  id            String      @id @default(cuid())
  gym_id        String
  coach_id      String
  weight_bps    Int         // basis points, all weights for a gym must sum to 10000
  gym           GymProfile  @relation(fields: [gym_id], references: [id])
  created_at    DateTime    @default(now())
  updated_at    DateTime    @updatedAt
  @@unique([gym_id, coach_id])
}

## Invite redemption logic (pseudo):
POST /invites/redeem detects gym slug in invite token →
  1. Load GymProfile + active sub-coaches ordered by assignment_position
  2. If ROUND_ROBIN: assign coach at index (round_robin_cursor % coach_count), increment cursor
  3. If WEIGHTED: find coach whose cumulative_assignments / total_assignments ratio is furthest below their weight_bps/10000 target
  4. Assign that coach to client (user.coach_id = assigned_coach_id)
  5. Standard onboarding flow continues

## Endpoints required (future):
GET  /gym/distribution           → { mode, weights: [{coach_id, coach_name, weight_bps}] }
PATCH /gym/distribution          → { mode, weights? }
GET  /gym/qr                     → { slug, deep_link_url, qr_code_svg }
