/**
 * CRISIS-STAFF-OFF-BE (owner #203-E34, answering 203-D7): for v1 a community text Roman's crisis check matches tells
 * no owner-role account. Off: CommunitySafetyService.alertStaff returns at its first line (no owner read, no inbox
 * row, no push, no log line), and the push worker drops a staff crisis push still queued from before
 * (PushDeliveryService.stillOwed). The poster keeps crisis_flag and the 988 line. The sender's code stays, so this one
 * line turns it back on. COACH-REPORT-TO-OWNER (v1.1: a message a coach reports, to the owner's TGP coach account) is
 * a different sender, not this one.
 */
export const COMMUNITY_CRISIS_STAFF_ALERT_ON = false;
