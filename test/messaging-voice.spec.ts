import { BadRequestException } from '@nestjs/common';
import { MessagingService } from '../src/messaging/messaging.service';

// Phase 6C — async voice notes on coach<->client messages. Verifies:
//   * voice attached to a coach send persists with all four columns
//   * body becomes optional when voice is present
//   * empty body + no voice is rejected (MESSAGE_EMPTY)
//   * over-duration / over-size / unknown content_type are rejected with
//     stable error codes
//   * voice-path PTM signals fire with value = duration_sec * 10
//
// Uses an in-memory Prisma + stubs (no live database).

function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null }> = [];
  const messages: Array<Record<string, unknown>> = [];
  let seq = 0;
  const newId = () => `m-${++seq}`;

  return {
    _users: users,
    _messages: messages,
    user: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = users.find((u) => {
          for (const [k, v] of Object.entries(where)) {
            if ((u as any)[k] !== v) return false;
          }
          return true;
        });
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where, select }: any) => {
        const row = users.find((u) => {
          for (const [k, v] of Object.entries(where)) {
            if ((u as any)[k] !== v) return false;
          }
          return true;
        });
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
    },
    coachMessage: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: newId(), ...data, created_at: new Date(), read_at: null };
        messages.push(row);
        return { ...row };
      }),
    },
  };
}

function makeService(): {
  svc: MessagingService;
  ptm: { emit: jest.Mock };
  prisma: ReturnType<typeof makePrisma>;
} {
  const prisma = makePrisma();
  prisma._users.push(
    { id: 'coach-A', role: 'coach', coach_id: null },
    { id: 'client-1', role: 'student', coach_id: 'coach-A' },
  );
  const supabase = {
    broadcastNewMessage: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn(),
  } as any;
  const analytics = { capture: jest.fn(), identify: jest.fn() } as any;
  const ptm = { emit: jest.fn() };
  const svc = new MessagingService(prisma as any, supabase, analytics, ptm as any);
  return { svc, ptm, prisma };
}

const validVoice = {
  url: 'https://storage.example/voice/abc.m4a',
  duration_sec: 30,
  size_bytes: 200_000,
  content_type: 'audio/m4a',
};

describe('MessagingService — voice notes (Phase 6C)', () => {
  beforeEach(() => {
    delete process.env.VOICE_NOTE_MAX_DURATION_SEC;
    delete process.env.VOICE_NOTE_MAX_SIZE_MB;
  });

  it('persists all four voice columns when a coach sends a voice note', async () => {
    const { svc, prisma } = makeService();
    const created = (await svc.sendAsCoach('coach-A', 'client-1', {
      voice: validVoice,
    })) as any;
    expect(created.voice_url).toBe(validVoice.url);
    expect(created.voice_duration_sec).toBe(30);
    expect(created.voice_size_bytes).toBe(200_000);
    expect(created.voice_content_type).toBe('audio/m4a');
    expect(prisma._messages).toHaveLength(1);
  });

  it('makes body optional when voice is present (voice-only persists with body=null)', async () => {
    const { svc } = makeService();
    const created = (await svc.sendAsCoach('coach-A', 'client-1', {
      voice: validVoice,
    })) as any;
    expect(created.body).toBeNull();
  });

  it('still requires body when no voice is supplied (MESSAGE_EMPTY)', async () => {
    const { svc } = makeService();
    await expect(
      svc.sendAsCoach('coach-A', 'client-1', { body: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.sendAsCoach('coach-A', 'client-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a body+voice combo and persists both', async () => {
    const { svc } = makeService();
    const created = (await svc.sendAsCoach('coach-A', 'client-1', {
      body: 'transcript fallback',
      voice: validVoice,
    })) as any;
    expect(created.body).toBe('transcript fallback');
    expect(created.voice_url).toBe(validVoice.url);
  });

  it('rejects an unknown content_type with VOICE_CONTENT_TYPE_REJECTED', async () => {
    const { svc } = makeService();
    let err: any;
    try {
      await svc.sendAsCoach('coach-A', 'client-1', {
        voice: { ...validVoice, content_type: 'audio/midi' },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toBe('VOICE_CONTENT_TYPE_REJECTED');
  });

  it('rejects an over-duration voice note with VOICE_DURATION_OUT_OF_RANGE', async () => {
    const { svc } = makeService();
    let err: any;
    try {
      await svc.sendAsCoach('coach-A', 'client-1', {
        voice: { ...validVoice, duration_sec: 400 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toBe('VOICE_DURATION_OUT_OF_RANGE');
    expect(err.getResponse().max_seconds).toBe(300);
  });

  it('respects VOICE_NOTE_MAX_DURATION_SEC override (clamped 10..600)', async () => {
    process.env.VOICE_NOTE_MAX_DURATION_SEC = '120';
    const { svc } = makeService();
    let err: any;
    try {
      await svc.sendAsCoach('coach-A', 'client-1', {
        voice: { ...validVoice, duration_sec: 200 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().max_seconds).toBe(120);
  });

  it('rejects an over-size voice note with VOICE_SIZE_OUT_OF_RANGE', async () => {
    const { svc } = makeService();
    let err: any;
    try {
      await svc.sendAsCoach('coach-A', 'client-1', {
        voice: { ...validVoice, size_bytes: 10 * 1024 * 1024 }, // 10 MB > default 5 MB
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toBe('VOICE_SIZE_OUT_OF_RANGE');
  });

  it('emits PTM voice signals at duration_sec * 10 (coach send)', async () => {
    const { svc, ptm } = makeService();
    await svc.sendAsCoach('coach-A', 'client-1', {
      voice: { ...validVoice, duration_sec: 25 },
    });
    expect(ptm.emit).toHaveBeenCalledWith(
      'client-1',
      'message_received',
      250,
      expect.objectContaining({ voice: true, duration_sec: 25 }),
    );
    expect(ptm.emit).toHaveBeenCalledWith(
      'client-1',
      'coach_note_received',
      1,
      expect.objectContaining({ voice: true }),
    );
  });

  it('emits PTM voice signals at duration_sec * 10 (client send)', async () => {
    const { svc, ptm } = makeService();
    await svc.sendAsClient('client-1', {
      voice: { ...validVoice, duration_sec: 12 },
    });
    expect(ptm.emit).toHaveBeenCalledWith(
      'client-1',
      'message_sent',
      120,
      expect.objectContaining({ voice: true, duration_sec: 12 }),
    );
  });

  it('does NOT fire voice PTM signals when only text is sent (text path is owned by Phase 1A)', async () => {
    const { svc, ptm } = makeService();
    await svc.sendAsCoach('coach-A', 'client-1', { body: 'plain text' });
    // The voice-branch metadata flag is the tell — no emit() call carrying
    // { voice: true } should have happened.
    const voiceCalls = ptm.emit.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[3] === 'object' &&
        call[3] !== null &&
        (call[3] as any).voice === true,
    );
    expect(voiceCalls).toHaveLength(0);
  });
});
