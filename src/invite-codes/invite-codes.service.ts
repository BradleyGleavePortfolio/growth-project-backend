import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';

type ValidationSuccess = {
  valid: true;
  coach_id: string;
  coach_name: string;
  invite_code_id: string;
};
type ValidationFailure = { valid: false; reason: string };
export type ValidationResult = ValidationSuccess | ValidationFailure;

// Unambiguous alphabet — no 0/O, 1/I/L — so codes read unambiguously over the
// phone or in handwriting. 32 chars × 6 = 2^30 combinations, plenty for the
// foreseeable code volume.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'GP-';
const MAX_GENERATION_ATTEMPTS = 10;

@Injectable()
export class InviteCodesService {
  private readonly logger = new Logger(InviteCodesService.name);

  constructor(private prisma: PrismaService) {}

  // Generates a human-friendly `GP-XXXXXX` code. Retries on the (astronomically
  // unlikely) unique-collision so callers never see a spurious 500.
  private generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = CODE_PREFIX;
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  async createForCoach(
    coachId: string,
    input: { expires_at?: string; max_uses?: number },
  ) {
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Invalid expires_at');
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expires_at must be in the future');
    }

    // Retry loop for the (extremely rare) unique-index collision on `code`.
    // Prisma throws P2002 on unique violation; anything else bubbles.
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const code = this.generateCode();
      try {
        return await this.prisma.inviteCode.create({
          data: {
            code,
            coach_id: coachId,
            expires_at: expiresAt,
            max_uses: input.max_uses ?? null,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          this.logger.warn(`invite code collision on ${code}, retrying`);
          continue;
        }
        throw err;
      }
    }
    // Astronomically unlikely: 10 consecutive collisions against a 30-bit space.
    throw new InternalServerErrorException('Could not generate a unique invite code');
  }

  async listForCoach(coachId: string) {
    return this.prisma.inviteCode.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
    });
  }

  async revokeForCoach(coachId: string, inviteCodeId: string) {
    const existing = await this.prisma.inviteCode.findUnique({
      where: { id: inviteCodeId },
    });
    if (!existing) throw new NotFoundException('Invite code not found');
    // IDOR guard: a coach can only revoke their own codes.
    if (existing.coach_id !== coachId) {
      throw new ForbiddenException('Invite code does not belong to caller');
    }
    return this.prisma.inviteCode.update({
      where: { id: inviteCodeId },
      data: { revoked: true },
    });
  }

  // Shared validation used by both the public endpoint and the signup wire-up.
  // Returns a structured result rather than throwing so the caller can choose
  // the right HTTP shape (public endpoint returns {valid:false}; signup wants 400).
  async validate(code: string): Promise<ValidationResult> {
    const record = await this.prisma.inviteCode.findUnique({
      where: { code },
      include: { coach: { select: { id: true, name: true, role: true } } },
    });
    if (!record) return { valid: false, reason: 'not_found' };
    if (record.revoked) return { valid: false, reason: 'revoked' };
    if (record.expires_at && record.expires_at.getTime() <= Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    if (record.max_uses !== null && record.used_count >= record.max_uses) {
      return { valid: false, reason: 'max_uses_reached' };
    }
    // Defensive: only a coach-role user should be able to claim students. If a
    // coach was later demoted, refuse to honor their codes.
    if (record.coach.role !== 'coach') {
      return { valid: false, reason: 'coach_inactive' };
    }
    return {
      valid: true,
      coach_id: record.coach.id,
      coach_name: record.coach.name,
      invite_code_id: record.id,
    };
  }
}
