#!/usr/bin/env python3
"""Independent log-sink scan (AUD-OPUS-FU2-118). Finds every call to a log-ish method
(.log/.warn/.error/.debug/.verbose/.info/.fatal/.trace) and Sentry capture/breadcrumb/extra calls,
under any receiver name, extracts the full argument list (multi-line), strips the static text of
string literals, keeps template expressions and bare code, and flags suspicious tokens. Output is
for manual review, not a verdict."""
import os, re, sys

ROOT = sys.argv[1]
CALL = re.compile(r"(?:\.\s*(log|warn|error|debug|verbose|info|fatal|trace)|\b(captureMessage|captureException|addBreadcrumb|setExtra|setExtras|setContext|setUser|setTag))\s*\(")

def skip_quoted(s, i, q):
    i += 1
    while i < len(s) and s[i] != q:
        if s[i] == '\\':
            i += 1
        i += 1
    return i + 1

def read_template(s, i):
    exprs = []
    i += 1
    while i < len(s) and s[i] != '`':
        if s[i] == '\\':
            i += 2; continue
        if s[i] == '$' and i + 1 < len(s) and s[i+1] == '{':
            d = 1; j = i + 2; e = ''
            while j < len(s) and d > 0:
                c = s[j]
                if c in '\'"':
                    j = skip_quoted(s, j, c); e += ' STR '; continue
                if c == '`':
                    ex, j = read_template(s, j); e += ' ' + ' '.join(ex) + ' '; continue
                if c == '{': d += 1
                if c == '}':
                    d -= 1
                    if d == 0: break
                e += c; j += 1
            exprs.append(e); i = j + 1; continue
        i += 1
    return exprs, i + 1

def arg_code(s, start):
    out = ''; depth = 1; i = start
    while i < len(s):
        c = s[i]
        if c in '\'"':
            i = skip_quoted(s, i, c); out += ' STR '; continue
        if c == '`':
            ex, i = read_template(s, i); out += ' ' + ' '.join(ex) + ' '; continue
        if c == '/' and s[i+1:i+2] == '/':
            while i < len(s) and s[i] != '\n': i += 1
            continue
        if c == '/' and s[i+1:i+2] == '*':
            k = s.find('*/', i+2); i = len(s) if k < 0 else k + 2; continue
        if c == '(': depth += 1
        if c == ')':
            depth -= 1
            if depth == 0: break
        out += c; i += 1
    return out

SUSPECT = re.compile(r"(?i)(e-?mail|\bmail\b|addr|recipient|\bto\b|name|phone|message|\bbody\b|\bnote|\btext\b|content|subject|title|caption|bio\b|prompt|transcript|payload|stringify|inspect\(|\bdto\b|\binput\b|\bdata\b|reason|description|comment|query|params|\breq\b|request|headers|token|ip\b|address|street|zip|dob|birth|weight|calorie|symptom|diagnos|medic)")
BENIGN = re.compile(r"(?i)^(err\.message|error\.message|e\.message|\(err as Error\)\.message|err instanceof Error \? err\.message : STR|String\(err\)|err\.name|error\.name|constructor\.name|\w+\.constructor\.name)$")

rows = []
for dp, dn, fn in os.walk(ROOT):
    dn[:] = [d for d in dn if d not in ('__tests__', '__mocks__', 'node_modules')]
    for f in fn:
        if not f.endswith('.ts') or f.endswith('.d.ts') or re.search(r"\.(spec|test)\.ts$", f):
            continue
        p = os.path.join(dp, f)
        s = open(p, encoding='utf8').read()
        for m in CALL.finditer(s):
            # skip obvious non-log receivers for .error/.log etc? keep all, filter later
            pre = s[max(0, m.start()-40):m.start()]
            recv = re.search(r"([\w$.\]\)]+)\s*$", pre)
            recv = recv.group(1) if recv else ''
            code = arg_code(s, m.end())
            flat = re.sub(r"\s+", " ", code).strip()
            line = s.count('\n', 0, m.start()) + 1
            rows.append((os.path.relpath(p, ROOT), line, recv, m.group(1) or m.group(2), flat))

out_all = []
for r in rows:
    f, line, recv, meth, flat = r
    if meth in ('log','warn','error','debug','verbose','info','fatal','trace'):
        # receiver should look like a logger/console/log/sentry
        if not re.search(r"(?i)(log|console|sentry|audit|pino|winston)", recv):
            continue
    tokens = flat
    if SUSPECT.search(tokens):
        out_all.append(f"{f}:{line} [{recv}.{meth}] {flat[:220]}")
print(f"total calls matched: {len(rows)}; flagged: {len(out_all)}")
print('\n'.join(out_all))
