import { cutGuard } from './utils/ls-1186-probe-fixture';

// Remove only the brief sender's Mute all condition, in the isolated CI checkout.
cutGuard(
  'src/coach/brief/coach-brief.scheduler.ts',
  'if (notificationPrefs?.muted === true) {',
  'if (false) {',
);
// The new registry stays green. The independent existing sender sentinel is red.
require('../src/notifications/__tests__/sender-registry.spec');
require('./coach-brief.service.spec');
