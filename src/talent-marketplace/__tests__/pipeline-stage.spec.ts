import {
  PIPELINE_STAGES,
  canTransition,
  isPipelineStage,
  isTerminalStage,
  stageToStatus,
  statusToStage,
  tryStatusToStage,
  type PipelineStage,
} from '../pipeline-stage';

// TM-8 — pipeline state machine invariants. The hirer vocabulary maps onto the
// persisted ApplicationStatus enum (no schema change), so the round-trip and the
// transition matrix are the contract auditor A will lean on.

describe('pipeline-stage — enum + guards', () => {
  it('exposes the six canonical stages in order', () => {
    expect(PIPELINE_STAGES).toEqual([
      'new',
      'screening',
      'interview',
      'offer',
      'hired',
      'passed',
    ]);
  });

  it('isPipelineStage narrows valid values and rejects junk', () => {
    expect(isPipelineStage('screening')).toBe(true);
    expect(isPipelineStage('SCREENING')).toBe(false);
    expect(isPipelineStage('')).toBe(false);
    expect(isPipelineStage(null)).toBe(false);
    expect(isPipelineStage(42)).toBe(false);
  });

  it('marks hired and passed as terminal, others as non-terminal', () => {
    expect(isTerminalStage('hired')).toBe(true);
    expect(isTerminalStage('passed')).toBe(true);
    for (const s of ['new', 'screening', 'interview', 'offer'] as PipelineStage[]) {
      expect(isTerminalStage(s)).toBe(false);
    }
  });
});

describe('pipeline-stage — transition matrix', () => {
  it('allows the linear advance path', () => {
    expect(canTransition('new', 'screening')).toBe(true);
    expect(canTransition('screening', 'interview')).toBe(true);
    expect(canTransition('interview', 'offer')).toBe(true);
    expect(canTransition('offer', 'hired')).toBe(true);
  });

  it('allows an early passed from any non-terminal stage', () => {
    expect(canTransition('new', 'passed')).toBe(true);
    expect(canTransition('screening', 'passed')).toBe(true);
    expect(canTransition('interview', 'passed')).toBe(true);
    expect(canTransition('offer', 'passed')).toBe(true);
  });

  it('rejects backward and skip transitions', () => {
    expect(canTransition('hired', 'new')).toBe(false);
    expect(canTransition('interview', 'new')).toBe(false);
    expect(canTransition('new', 'offer')).toBe(false);
    expect(canTransition('new', 'hired')).toBe(false);
  });

  it('forbids any outbound transition from a terminal stage', () => {
    for (const to of PIPELINE_STAGES) {
      expect(canTransition('hired', to)).toBe(false);
      expect(canTransition('passed', to)).toBe(false);
    }
  });
});

describe('pipeline-stage — status mapping round-trip', () => {
  it('round-trips every stage through its persisted status', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(statusToStage(stageToStatus(stage))).toBe(stage);
    }
  });

  it('maps out-of-band statuses to new rather than throwing (display path)', () => {
    expect(statusToStage('withdrawn')).toBe('new');
  });

  it('tryStatusToStage returns null for statuses with no pipeline representation (write path)', () => {
    // withdrawn is the applicant's own opt-out: the WRITE path must NOT coerce
    // it to `new` and resurrect it (A-P0-1 / B-P1-1).
    expect(tryStatusToStage('withdrawn')).toBeNull();
  });

  it('tryStatusToStage round-trips every mapped status back to its stage', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(tryStatusToStage(stageToStatus(stage))).toBe(stage);
    }
  });
});
