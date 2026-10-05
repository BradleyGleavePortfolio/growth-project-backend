import re, subprocess, sys
src = subprocess.check_output(['git','-C','/home/user/workspace/repos/growth-project-backend','show','958806d15af64863786337699020428cd89ffaf3:src/checkout/subscription-checkout.service.ts']).decode()
L = src.split('\n')
def rng(a,b): return L[a-1:b]  # 1-based inclusive
def dedent_method(lines, newname=None):
    out=[]
    for l in lines:
        m = re.match(r'^  (?:private )?(\w+)\((.*)$', l)
        if m:
            out.append(f'export function {newname or m.group(1)}({m.group(2)}'); continue
        out.append(l[2:] if l.startswith('  ') else l)
    return out
plan = []
plan += ['// B-RECUR (split R1 of #654; inert until R2 wires it) — the pure contracts,',
         '// constants and Stripe-object readers of the native subscription checkout,',
         '// moved verbatim out of subscription-checkout.service.ts (R2) to keep each',
         '// piece under the size limit (operator 116 size ruling). Nothing in R1 calls',
         '// this file; R2 (subscription-checkout.service.ts) is its only caller.',
         "import { ConflictException, HttpException } from '@nestjs/common';",
         "import type { ClientPurchase, CoachPackage } from '@prisma/client';",
         'import {',
         '  StripeConnectApiError,',
         '  type StripeSubscriptionCheckoutObject,',
         "} from '../connect/stripe-connect-api.service';",
         '']
body = rng(68,158) + [''] + rng(160,250) + [''] + rng(260,326)
fixed=[]
for l in body:
    l = re.sub(r'^const ', 'export const ', l)
    l = re.sub(r'^function ', 'export function ', l)
    fixed.append(l)
plan += fixed + ['']
cls = rng(1000,1016)
plan += dedent_method(cls) + ['']
plan += dedent_method(rng(1018,1026)) + ['']
plan += dedent_method(rng(1377,1399)) + ['']
tp = rng(1440,1494)
plan += dedent_method(tp, 'planView')
# preserve doc comments above moved methods
open('/home/user/workspace/wt/B-RECUR2-116-678/src/checkout/subscription-plan.ts','w').write('\n'.join(plan)+'\n')
errs = ['// B-RECUR (split R1 of #654; inert until R2 wires it) — the coded answers',
        '// of the native subscription checkout, moved verbatim out of',
        '// subscription-checkout.service.ts (R2) as plain functions (operator 116',
        '// size ruling). Nothing in R1 calls this file.',
        'import {',
        '  BadRequestException,',
        '  ConflictException,',
        '  HttpException,',
        '  NotFoundException,',
        '  ServiceUnavailableException,',
        "} from '@nestjs/common';",
        "import type { ClientPurchase } from '@prisma/client';",
        "import { StripeConnectApiError } from '../connect/stripe-connect-api.service';",
        "import { iso } from './subscription-plan';",
        '']
seg = rng(1725,1838)
out=[]
for l in seg:
    m = re.match(r'^  private (\w+)\((.*)$', l)
    if m:
        out.append(f'export function {m.group(1)}({m.group(2)}'); continue
    out.append(l[2:] if l.startswith('  ') else l)
errs += out
open('/home/user/workspace/wt/B-RECUR2-116-678/src/checkout/subscription-errors.ts','w').write('\n'.join(errs)+'\n')
