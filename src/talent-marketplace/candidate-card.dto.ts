// TM-8 — CandidateCard: the PII-stripped applicant projection for the hirer
// queue.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PII ALLOW-LIST (auditor A verifies). A CandidateCard carries ONLY:         ║
// ║   first name, last initial, specialty, fit-score, pipeline stage,          ║
// ║   application id + created-at. It NEVER carries email, phone, full last    ║
// ║   name, DOB, address, IP, or payment info. The builder below is the SOLE   ║
// ║   constructor — raw Applicant / Application rows are never spread.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import type { PipelineStage } from './pipeline-stage';
import { statusToStage } from './pipeline-stage';
import type { Applicant, Application } from '@prisma/client';

export interface CandidateCardDto {
  application_id: string;
  first_name: string;
  // Single-character initial only — the full surname is PII and is withheld.
  last_initial: string;
  specialty: string | null;
  fit_score: number | null;
  stage: PipelineStage;
  applied_at: string;
}

// Coarse, lossy projection of the surname to a single initial. Returns '' for an
// empty surname rather than throwing so a malformed row still renders.
function toLastInitial(lastName: string): string {
  const trimmed = lastName.trim();
  return trimmed.length > 0 ? `${trimmed[0].toUpperCase()}.` : '';
}

// The ONLY way to build a CandidateCard. Takes the narrow column subset the
// service selects — never the full entity — so no PII column can leak by
// accident.
export function toCandidateCard(
  application: Pick<Application, 'id' | 'fit_score' | 'status' | 'created_at'>,
  applicant: Pick<Applicant, 'first_name' | 'last_name' | 'specialties'>,
): CandidateCardDto {
  return {
    application_id: application.id,
    first_name: applicant.first_name,
    last_initial: toLastInitial(applicant.last_name),
    specialty: applicant.specialties[0] ?? null,
    fit_score: application.fit_score,
    stage: statusToStage(application.status),
    applied_at: application.created_at.toISOString(),
  };
}
