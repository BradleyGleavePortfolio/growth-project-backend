import { BadRequestException } from '@nestjs/common';
import { AuthController } from '../src/auth/auth.controller';

// Focused controller spec for the public invite-code surface. Mobile QA on
// PR #61 surfaced two production divergences this spec pins:
//
//   1. /auth/signup-policy must expose `invite_code_required` (canonical)
//      and `invite_code` length / prefix spec so the client can validate
//      input before round-tripping.
//   2. /auth/validate-invite-code must reject malformed input (length /
//      character class) with a polished structured 400 carrying a stable
//      `code: 'invite_code_invalid_format'` — never the raw class-validator
//      array — and must not leak whether a malformed code exists or echo
//      the user's input back.

describe('AuthController.validateInviteCode (public)', () => {
  const buildController = () => {
    const inviteCodes = {
      validate: jest.fn(),
      attachUserToCoachByCode: jest.fn(),
    } as any;
    const auth = {} as any;
    const controller = new AuthController(auth, inviteCodes);
    return { controller, inviteCodes };
  };

  it('returns a polished structured 400 for codes longer than the documented max', async () => {
    const { controller, inviteCodes } = buildController();
    const tooLong = 'GP-' + 'A'.repeat(64);
    let caught: any;
    try {
      await controller.validateInviteCode({ code: tooLong } as any);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = caught.getResponse();
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'invite_code_invalid_format',
      message: 'Invite code format is invalid.',
    });
    // Crucial: don't leak whether the raw input would have resolved.
    expect(inviteCodes.validate).not.toHaveBeenCalled();
    // Don't echo the user's input on the invalid path.
    expect(JSON.stringify(body)).not.toContain(tooLong);
  });

  it('returns the same structured 400 for short codes (no leak between cases)', async () => {
    const { controller, inviteCodes } = buildController();
    let caught: any;
    try {
      await controller.validateInviteCode({ code: 'AB' } as any);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.getResponse()).toMatchObject({
      code: 'invite_code_invalid_format',
      message: 'Invite code format is invalid.',
    });
    expect(inviteCodes.validate).not.toHaveBeenCalled();
  });

  it('returns the same structured 400 for codes with disallowed characters', async () => {
    const { controller, inviteCodes } = buildController();
    let caught: any;
    try {
      await controller.validateInviteCode({ code: 'GP ABC$%' } as any);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.getResponse()).toMatchObject({
      code: 'invite_code_invalid_format',
    });
    expect(inviteCodes.validate).not.toHaveBeenCalled();
  });

  it('trims whitespace before validating so a stray newline does not 400 a real code', async () => {
    const { controller, inviteCodes } = buildController();
    inviteCodes.validate.mockResolvedValue({
      valid: true,
      coach_id: 'coach-1',
      coach_name: 'Sasha Lin',
      invite_code_id: 'ic-1',
    });
    const result = await controller.validateInviteCode({ code: '  GP-ABC123\n' } as any);
    expect(inviteCodes.validate).toHaveBeenCalledWith('GP-ABC123');
    expect(result).toEqual({
      valid: true,
      coach_id: 'coach-1',
      coach_name: 'Sasha Lin',
    });
  });

  it('returns {valid:false} for a well-formed but unknown code (no leak)', async () => {
    const { controller, inviteCodes } = buildController();
    inviteCodes.validate.mockResolvedValue({ valid: false, reason: 'not_found' });
    const result = await controller.validateInviteCode({ code: 'GP-ZZZZZZ' } as any);
    // Must NOT include `reason`. Mobile only learns "not valid".
    expect(result).toEqual({ valid: false });
  });
});
