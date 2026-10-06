#!/usr/bin/env node
'use strict';

// Operator tooling only. No application imports, database client or service key.
const { createHash } = require('node:crypto');

function requireValue(env, key) {
  if (!env[key]) throw new Error(`Set ${key} before continuing.`);
  return env[key];
}

function readConfig(env, apply = false) {
  const url = new URL(requireValue(env, 'REVIEW_API_BASE_URL'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (!local && url.protocol !== 'https:') ||
      !['', '/', '/api', '/api/'].includes(url.pathname)) {
    throw new Error('Use an HTTP loopback or HTTPS API origin, optionally ending in /api, without credentials or query parameters.');
  }
  const endDate = requireValue(env, 'REVIEW_END_DATE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      Number.isNaN(Date.parse(endDate)) || day(endDate, 0) !== endDate) {
    throw new Error('REVIEW_END_DATE must be a valid YYYY-MM-DD date. Keep it unchanged on reruns.');
  }
  if (apply) {
    if (env.REVIEW_CONFIRM_SYNTHETIC !== 'yes') {
      throw new Error('Set REVIEW_CONFIRM_SYNTHETIC=yes only for dedicated synthetic review accounts.');
    }
    if (!local && (env.REVIEW_OWNER_APPROVED !== 'yes' ||
        env.REVIEW_EXPECTED_ORIGIN !== url.origin)) {
      throw new Error('Remote execution needs owner approval: REVIEW_OWNER_APPROVED=yes and REVIEW_EXPECTED_ORIGIN matching the approved origin exactly.');
    }
  }
  const config = { baseUrl: `${url.origin}/api`, endDate, local };
  if (apply) {
    config.expectedCoachEmail = requireValue(env, 'REVIEW_EXPECTED_COACH_EMAIL');
    config.expectedClientEmail = requireValue(env, 'REVIEW_EXPECTED_CLIENT_EMAIL');
    config.coachEmail = requireValue(env, 'REVIEW_COACH_EMAIL');
    config.coachPassword = requireValue(env, 'REVIEW_COACH_PASSWORD');
    config.clientEmail = requireValue(env, 'REVIEW_CLIENT_EMAIL');
    config.clientPassword = requireValue(env, 'REVIEW_CLIENT_PASSWORD');
    if (config.coachEmail.trim().toLowerCase() === config.clientEmail.trim().toLowerCase()) {
      throw new Error('The coach and client must be two separate confirmed accounts.');
    }
  }
  return config;
}

function day(anchor, offset) {
  const date = new Date(`${anchor}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function key(text) {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function describePlan(config) {
  return {
    mode: 'offline plan — no HTTP requests',
    api: config.baseUrl,
    dates: Array.from({ length: 7 }, (_, i) => day(config.endDate, i - 6)),
    steps: [
      'Sign in to the two confirmed accounts; verify coach and client roles.',
      'Pair the client using the coach invite code; refuse another coach.',
      'Create and publish a synthetic $0 one-time package, then claim its entitlement.',
      'Stop for in-app agreement completion if the grant is pending consent.',
      'Build a one-week program with three populated workouts and assign it.',
      'Add seven dated workouts and three meals per day using existing catalog foods.',
      'Add one check-in and one synthetic text message in each direction.',
      'Keep existing availability, or add daily 09:00–17:00 hours when empty.',
      'Book an API-provided open slot and approve it as the coach; no invented call link.',
      'Join the coach community through its first-open bootstrap and verify membership.',
    ],
    rerun: 'Keep REVIEW_END_DATE and the two accounts unchanged. Existing samples are skipped.',
    payments: 'No checkout, subscriptions, payment methods, paid trials or provider APIs.',
  };
}

function httpTransport(config, fetchImpl = globalThis.fetch) {
  return async function request(role, method, path, body, token, idempotencyKey) {
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`${role}: ${method} ${path.split('?')[0]} could not reach the API. Check the approved URL and connection, then rerun.`);
    }
    if (!response.ok) {
      // Never print a response body: login/error responses can echo credentials.
      const recovery = response.status === 402 ? ' Complete the client agreement and check the free-plan entitlement in the app.' :
        response.status === 409 ? ' Check pairing and agreement requirements in the app.' :
        response.status === 429 ? ' Wait for the API rate limit to clear before rerunning.' :
        response.status === 401 ? ' Verify both confirmed account logins.' :
        response.status === 404 || response.status === 503 ? ' Check that the required launch features are available.' : '';
      throw new Error(`${role}: ${method} ${path.split('?')[0]} returned HTTP ${response.status}.${recovery}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`${role}: ${method} ${path.split('?')[0]} did not return JSON. Check the API base URL.`);
    }
  };
}

function array(value, field) {
  const rows = field ? value?.[field] : value;
  if (!Array.isArray(rows)) throw new Error(`The API response must contain ${field || 'an array'}. Check the deployed API contract.`);
  return rows;
}

function emailIdentity(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function seed(config, request = httpTransport(config)) {
  for (const role of ['coach', 'client']) {
    const expected = emailIdentity(config[role === 'coach' ? 'expectedCoachEmail' : 'expectedClientEmail']);
    if (!expected || emailIdentity(config[`${role}Email`]) !== expected) {
      throw new Error(`The ${role} login must match its separately approved reviewer identity. Check the private approval pins, not a working account's credentials.`);
    }
  }
  const sessions = {};
  const report = { created: {}, skipped: {} };
  function count(action, step) {
    report[action][step] = (report[action][step] || 0) + 1;
  }
  async function call(role, method, path, body, stableKey) {
    return request(role, method, path, body, sessions[role]?.access_token, stableKey && key(stableKey));
  }
  async function pages(role, path, field, cursorField = 'next_cursor') {
    const rows = [];
    let cursor;
    do {
      const value = await call(role, 'GET', `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      rows.push(...array(value, field));
      cursor = value[cursorField];
    } while (cursor);
    return rows;
  }

  for (const role of ['coach', 'client']) {
    sessions[role] = await call(role, 'POST', '/auth/login', {
      email: config[`${role}Email`], password: config[`${role}Password`],
    });
    if (!sessions[role]?.access_token || !sessions[role]?.user?.id ||
        sessions[role].user.role !== (role === 'coach' ? 'coach' : 'student')) {
      throw new Error(`The ${role} login must have the ${role === 'coach' ? 'coach' : 'student'} role. No role changes are made by this tool.`);
    }
    if (emailIdentity(sessions[role].user.email) !==
        emailIdentity(config[role === 'coach' ? 'expectedCoachEmail' : 'expectedClientEmail'])) {
      throw new Error(`The signed-in ${role} does not match its approved reviewer identity. No review data has been written.`);
    }
  }
  const coachId = sessions.coach.user.id;
  const clientId = sessions.client.user.id;
  if (coachId === clientId) throw new Error('Use two separate confirmed review accounts.');
  if (sessions.client.user.coach_id && sessions.client.user.coach_id !== coachId) {
    throw new Error('This client belongs to another coach. Use a dedicated review client; no reassignment is performed.');
  }
  // This raw-array route includes archived clients. Two rows are sufficient:
  // at most one can be the single approved review client.
  const roster = array(await call('coach', 'GET', '/coach/clients?status=all&take=2'));
  if (roster.some(row => row.id !== clientId)) {
    throw new Error('The review coach has another client. Use a dedicated review coach with no clients except the approved review client; no review data has been written.');
  }
  const marker = `Store review ${key(`${coachId}:${clientId}`).slice(0, 8)}`;
  const programName = `${marker} training`;
  // Check required feature surfaces before creating packages or logs.
  const programs = await pages('coach', `/v1/coach/programs?q=${encodeURIComponent(programName)}&limit=100`, 'items');
  const coachCommunity = await call('coach', 'GET', '/community/me');
  if (coachCommunity.feature_flag_state !== 'enabled' || !coachCommunity.workspace_id) {
    throw new Error('Community must be enabled for the review coach. The tool does not change feature flags.');
  }
  if (!sessions.client.user.coach_id) {
    const invite = await call('coach', 'GET', '/coaches/me/invite-link');
    if (!invite.code) throw new Error('The review coach must have a working invite code.');
    const attached = await call('client', 'POST', '/auth/attach-invite-code', { invite_code: invite.code });
    if (attached.coach_id !== coachId) throw new Error('Pairing did not return the review coach. Stop and check the two accounts.');
    count('created', 'pairing');
  } else count('skipped', 'pairing');

  const packages = array(await call('coach', 'GET', '/v1/coach/packages'), 'packages');
  let pkg = packages.find(row => row.name === `${marker} coaching`);
  if (!pkg) {
    pkg = await call('coach', 'POST', '/v1/coach/packages', {
      name: `${marker} coaching`,
      description: 'Synthetic review-only coaching access. No payment and no renewal.',
      amount_cents: 0, currency: 'usd', billing_type: 'one_time',
    }, `${marker}:package`);
    count('created', 'package');
  } else count('skipped', 'package');
  if (!pkg.id || pkg.amount_cents !== 0 || pkg.billing_type !== 'one_time' ||
      pkg.recurring_amount_cents || pkg.archived_at || pkg.is_active === false) {
    throw new Error('The matching review package must be active, free and one-time without a recurring price. Do not modify paid offers.');
  }
  if (!pkg.published_at) await call('coach', 'POST', `/v1/coach/packages/${pkg.id}/publish`, {});
  const entitlementPath = `/v1/checkout/entitlement?package_id=${encodeURIComponent(pkg.id)}`;
  let entitlement = await call('client', 'GET', entitlementPath);
  if (!entitlement.active) {
    const grant = await call('client', 'POST', `/v1/packages/${pkg.id}/claim-free`);
    if (!grant.active) {
      throw new Error('The free grant is not active. Complete the client onboarding agreement in the app, then rerun. This tool never signs agreements or grants AI permission.');
    }
    entitlement = await call('client', 'GET', entitlementPath);
    count('created', 'entitlement');
  } else count('skipped', 'entitlement');
  if (!entitlement.active) throw new Error('The API did not confirm active review-plan entitlement. Check the client plan before continuing.');

  let program = programs.find(row => row.name === programName);
  if (!program) {
    program = await call('coach', 'POST', '/v1/coach/programs', {
      name: programName, description: 'Synthetic review-only training block.', goal_tag: 'Review sample',
      weeks: 1, days_per_week: 3,
    }, `${marker}:program`);
    count('created', 'program');
  } else {
    program = await call('coach', 'GET', `/v1/coach/programs/${program.id}`);
    count('skipped', 'program');
  }
  const exerciseResponse = await call('coach', 'GET', '/exercises/search?q=squat&limit=3');
  const exercises = array(exerciseResponse, 'items');
  if (!exercises.length) throw new Error('The public exercise catalog needs at least one squat exercise. Check catalog availability; no catalog rows are invented.');
  for (const dayIndex of [0, 2, 4]) {
    let slot = array(program, 'days').find(row => row.week_index === 0 && row.day_index === dayIndex);
    if (!slot) {
      program = await call('coach', 'PUT', `/v1/coach/programs/${program.id}/days/0/${dayIndex}`, {
        source: 'blank', name: `${marker} workout ${dayIndex + 1}`, type: 'strength',
      }, `${marker}:day:${dayIndex}`);
      slot = array(program, 'days').find(row => row.week_index === 0 && row.day_index === dayIndex);
    }
    if (!slot?.plan_id) throw new Error('The program day was not created. Check Programs before rerunning.');
    const plan = await call('coach', 'GET', `/workout-plans/${slot.plan_id}`);
    if (array(plan, 'exercises').length === 0) {
      await call('coach', 'PUT', `/workout-plans/${slot.plan_id}/exercises`, {
        rows: exercises.map((exercise, index) => ({
          exercise_external_id: exercise.id, order: index + 1, sets: 3,
          reps_or_duration_seconds: 10, weight_lbs: 0, rest_seconds: 60,
          notes: 'Synthetic review sample, not a personal exercise prescription.',
        })),
      }, `${marker}:exercises:${dayIndex}`);
      count('created', 'programWorkouts');
    } else count('skipped', 'programWorkouts');
  }
  const assignees = await pages('coach', `/v1/coach/programs/${program.id}/assignees?limit=100`, 'items');
  if (!assignees.some(row => row.client_id === clientId)) {
    const result = await call('coach', 'POST', `/v1/coach/programs/${program.id}/assign`, {
      client_ids: [clientId], start_date: day(config.endDate, 1), allow_repeat: false,
    }, `${marker}:assign`);
    if (!result.results?.some(row => row.client_id === clientId && ['assigned', 'already_assigned'].includes(row.status))) {
      throw new Error('The program assignment did not succeed. Check the client roster and Programs.');
    }
    count('created', 'assignment');
  } else count('skipped', 'assignment');

  const workouts = array(await call('client', 'GET', '/workouts?limit=100'));
  const foods = [];
  for (const query of ['oats', 'chicken', 'rice']) {
    const found = array(await call('client', 'GET', `/foods/search?q=${query}&limit=10`), 'results')[0];
    if (!found?.id) throw new Error(`The food catalog needs a ${query} result. No shared catalog food is created by this tool.`);
    foods.push(found);
  }
  for (let index = 0; index < 7; index++) {
    const date = day(config.endDate, index - 6);
    const name = `${marker} ${date}`;
    if (!workouts.some(row => row.workout_name === name && String(row.date).slice(0, 10) === date)) {
      await call('client', 'POST', '/workouts', {
        date: `${date}T12:00:00.000Z`, workout_name: name,
        workout_type: 'strength', duration_minutes: 30, intensity: 'moderate',
        notes: 'Synthetic store review training log.',
        exercises: [{
          exercise_name: 'Bodyweight squat', muscle_group: 'legs', sets_completed: 3,
          reps_per_set: [10, 10, 10], weight_per_set: [0, 0, 0], rpe: 5,
        }],
      });
      count('created', 'trainingLogs');
    } else count('skipped', 'trainingLogs');
    const entries = array(await call('client', 'GET', `/log/daily?date=${date}`), 'entries');
    for (const [mealIndex, meal] of ['breakfast', 'lunch', 'dinner'].entries()) {
      const uuid = key(`${marker}:meal:${date}:${meal}`);
      const notes = `${marker} ${meal} synthetic sample`;
      if (!entries.some(row => row.client_uuid === uuid || row.notes === notes)) {
        await call('client', 'POST', '/log/food', {
          date, meal_type: meal, food_item_id: foods[mealIndex].id, quantity_multiplier: 1,
          original_quantity: 1, original_unit: 'serving', notes, client_uuid: uuid,
        });
        count('created', 'meals');
      } else count('skipped', 'meals');
    }
  }
  const checkIns = array(await call('client', 'GET', `/check-ins?from=${config.endDate}&to=${config.endDate}&limit=1`));
  if (!checkIns.length) {
    await call('client', 'POST', '/check-ins', {
      date: config.endDate, mood: 4, energy: 4, sleep_hours: 7.5,
      notes: `${marker} synthetic check-in: training and meal logs are ready for review.`,
    });
    count('created', 'checkIn');
  } else count('skipped', 'checkIn');
  for (const role of ['client', 'coach']) {
    const path = role === 'client' ? '/messages' : `/coach/clients/${clientId}/messages`;
    const messages = array(await call(role, 'GET', `${path}?limit=100`));
    const uuid = key(`${marker}:message:${role}`);
    const body = `${marker}: ${role === 'client' ? 'Sample training and meal logs are ready.' : 'Sample logs reviewed. The next coaching session is available in Calendar.'}`;
    if (!messages.some(row => row.client_message_id === uuid || row.body === body)) {
      await call(role, 'POST', path, { body, client_message_id: uuid }, `${marker}:message:${role}`);
      count('created', 'messages');
    } else count('skipped', 'messages');
  }

  const types = array(await call('coach', 'GET', `/scheduling/coaches/${coachId}/session-types`));
  let type = types.find(row => row.name === `${marker} session`);
  if (!type) {
    type = await call('coach', 'POST', '/scheduling/session-types', {
      name: `${marker} session`, description: 'Synthetic review-only one-to-one coaching session.',
      duration_minutes: 30, auto_approve: false, default_video_provider: 'manual',
    });
    count('created', 'sessionType');
  } else count('skipped', 'sessionType');
  const availability = array(await call('coach', 'GET', `/scheduling/coaches/${coachId}/availability`));
  if (!availability.length) {
    await call('coach', 'POST', `/scheduling/coaches/${coachId}/availability`, {
      windows: Array.from({ length: 7 }, (_, day_of_week) => ({
        day_of_week, start_minute: 540, end_minute: 1020,
      })),
    });
    count('created', 'availability');
  } else count('skipped', 'availability');
  const bookings = [];
  for (const scope of ['upcoming', 'past']) {
    let after;
    let page;
    do {
      page = array(await call('client', 'GET', `/scheduling/sessions?scope=${scope}&limit=100${after || ''}`));
      bookings.push(...page);
      const last = page[page.length - 1];
      const direction = scope === 'past' ? 'before' : 'after';
      after = last ? `&${direction}=${encodeURIComponent(last.start_at)}&${direction}_id=${last.id}` : undefined;
    } while (page.length === 100);
  }
  let booking = bookings.find(row => row.title === `${marker} session` &&
    row.coach_id === coachId && ['requested', 'scheduled', 'pending_provider', 'completed'].includes(row.status));
  if (!booking) {
    const open = await call('client', 'GET', `/scheduling/coaches/${coachId}/open-slots?from=${day(config.endDate, 1)}&to=${day(config.endDate, 14)}&session_type_id=${type.id}`);
    const slot = array(open, 'slots')[0];
    if (!slot) throw new Error('No bookable review slot is available. Check coach availability and booking rules in the app, then rerun.');
    booking = await call('client', 'POST', '/scheduling/sessions', {
      coach_id: coachId, session_type_id: type.id, title: `${marker} session`,
      start_at: slot.start_at, end_at: slot.end_at,
    });
    count('created', 'booking');
  } else count('skipped', 'booking');
  if (booking.status === 'requested') {
    booking = await call('coach', 'POST', `/scheduling/sessions/${booking.id}/approve`, {
      expected_start_at: booking.start_at,
    });
  }
  if (!['scheduled', 'pending_provider', 'completed'].includes(booking.status)) {
    throw new Error('The coaching booking is not confirmed. Check Booking Inbox before store submission.');
  }
  const community = await call('client', 'GET', '/community/me');
  if (community.feature_flag_state !== 'enabled' || !community.membership ||
      community.workspace_id !== coachCommunity.workspace_id) {
    throw new Error('The client is not an active member of the review coach community. Check Community in the app; no ban or permission is bypassed.');
  }
  return {
    ...report, packageId: pkg.id, programId: program.id, bookingId: booking.id,
    activePlan: true, communityMembership: true, bookingStatus: booking.status,
    nextStep: 'Verify both accounts in the submitted mobile binary. Add a genuine coach call link in the app if demonstrating a video session.',
  };
}

if (require.main === module) {
  (async () => {
    const mode = process.argv[2] || '--plan';
    if (!['--plan', '--apply'].includes(mode)) throw new Error('Use --plan (offline) or --apply (approved synthetic accounts only).');
    const config = readConfig(process.env, mode === '--apply');
    const result = mode === '--apply' ? await seed(config) : describePlan(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readConfig, describePlan, httpTransport, seed, day, key };
