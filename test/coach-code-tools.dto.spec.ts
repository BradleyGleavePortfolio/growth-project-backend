import 'reflect-metadata';
import { CODE_LABEL_MAX, CreateCoachCodeDto } from '../src/invite-codes/coach-code-tools.dto';

describe('CreateCoachCodeDto API documentation', () => {
  it('uses the approved generic label example without changing the field constraints', () => {
    const label = Reflect.getMetadata(
      'swagger/apiModelProperties',
      CreateCoachCodeDto.prototype,
      'label',
    );

    expect(label).toMatchObject({
      description: 'Coach-facing name, e.g. "Front desk".',
      maxLength: CODE_LABEL_MAX,
      required: false,
    });
  });
});
