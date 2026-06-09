-- B5 supplemental — seed the 4 contract templates + TGP system-coach user.
--
-- DATA-ONLY migration (no DDL). Mirrors the repo's raw-SQL seed-migration
-- precedent (e.g. 20261211000001_seed_sleep_consistency_metric_defs).
-- Idempotent via ON CONFLICT DO NOTHING so re-running is a no-op.
--
-- The platform liability waiver (is_platform=true) needs a NOT NULL coach_id
-- FK; we seed a dedicated TGP system-coach User (fixed id) to satisfy it,
-- rather than making coach_id nullable. Coach-authored Layer-2 starters are
-- ALSO owned by the system coach as canonical library templates; a coach who
-- adopts one gets their own copy through ContractTemplateService.
--
-- DISCLAIMER: Draft wording prepared by agent without licensed legal review.
-- FEATURE_CONTRACTS_ENABLED MUST remain OFF in prod until reviewed by counsel.

INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
VALUES (
  'b5-system-coach-tgp',
  'b5-system-coach-tgp',
  'contracts-system@trygrowthproject.com',
  'Growth Project (System)',
  'coach'
)
ON CONFLICT ("id") DO NOTHING;

-- Platform Liability Waiver (platform-waiver-v1.md)
INSERT INTO "ContractTemplate"
  ("id", "coach_id", "is_platform", "name", "body_markdown", "version", "dynamic_fields_json", "requires_signature")
VALUES (
  'b5-tpl-platform-waiver-v1',
  'b5-system-coach-tgp',
  true,
  'Platform Liability Waiver',
  '---
id: platform-waiver-v1
slug: platform-liability-waiver
title: Growth Project Platform Agreement & Liability Waiver
is_platform: true
version: 1
layer: platform_waiver
requires_signature: true
parties: TGP (Growth Project) ↔ Client
jurisdiction: State of Delaware, USA
legal_basis:
  - ESIGN Act (15 U.S.C. ch. 96) + UETA — electronic signature validity
  - Marketplace/intermediary platform-not-provider posture
  - FTC Cooling-Off Rule scope (does NOT apply to online sales)
  - DMCA §512 notice-and-takedown safe harbor
  - Arbitration / governing-law clause drafting
sources:
  - "ESIGN/UETA four core elements (intent, consent, association, retention): https://ironcladapp.com/journal/contract-management/electronic-signature-law"
  - "ESIGN Act legal effect of electronic records & signatures: https://www.purduegloballawschool.edu/blog/news/e-signatures-legal-requirements"
  - "ESIGN vs UETA scope, excluded document types: https://helpx.adobe.com/legal/esignatures/regulations/united-states.html"
  - "FTC Cooling-Off Rule does NOT cover sales made entirely online: https://consumer.ftc.gov/articles/buyers-remorse-ftcs-cooling-rule-may-help"
  - "Cooling-off rule online-sales exclusion (Cornell LII Wex): https://www.law.cornell.edu/wex/cooling-off_rule"
  - "DMCA §512 safe harbor & designated agent (U.S. Copyright Office): https://www.copyright.gov/512/"
  - "17 U.S.C. §512 statutory text (Cornell LII): https://www.law.cornell.edu/uscode/text/17/512"
disclaimer: >
  Draft wording prepared by an automated agent WITHOUT licensed legal review.
  FEATURE_CONTRACTS_ENABLED MUST remain OFF in production until reviewed by counsel.
---

# Growth Project Platform Agreement & Liability Waiver

**Between:** Growth Project ("**TGP**", "**we**", "**us**", "**the Platform**") and **{{client.first_name}} {{client.last_name}}** ("**you**", "**the Client**").
**Effective date:** {{today}}.

By electronically signing below, you agree to the terms of this Platform Agreement & Liability Waiver. Please read it carefully — it affects your legal rights, including how disputes are resolved and the limits of TGP''s responsibility.

## 1. Electronic signature & consent (ESIGN / UETA)

You agree to transact with TGP electronically. You consent to use electronic records and electronic signatures, and you acknowledge that your electronic signature on this document has the same legal force and effect as a handwritten signature under the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN, 15 U.S.C. ch. 96) and the Uniform Electronic Transactions Act (UETA). You confirm that: (a) you **intend to sign** this record; (b) you **consent to do business electronically**; (c) this signature is **associated** with your identity and this specific document; and (d) you may request and **retain** a copy of the signed record. You may withdraw consent to transact electronically prospectively by contacting TGP, though doing so may prevent you from purchasing through the Platform.

## 2. TGP is a marketplace platform, not a coaching provider

TGP operates an online **marketplace** that connects independent coaches ("**Coaches**") with clients. **TGP does not itself provide coaching, training, nutrition, medical, mental-health, legal, or financial services.** When you purchase a package, you are **contracting directly with the Coach** for those services. The Coach — not TGP — is solely responsible for the content, quality, delivery, scheduling, results, and conduct of the services they provide.

## 3. No professional advice; assumption of risk

Content made available through the Platform is for general educational and informational purposes only and is **not** a substitute for professional medical, mental-health, legal, or financial advice. You should consult a qualified, licensed professional before acting on anything obtained through the Platform or a Coach. **You voluntarily assume full responsibility for your own decisions, actions, health, and results.** Coaching does not guarantee any specific outcome.

## 4. Limitation of TGP liability

To the maximum extent permitted by law, TGP is **not liable** for: (a) any act, omission, advice, content, injury, loss, or result arising from a Coach''s services; (b) disputes between you and a Coach, including refunds, cancellations, or service quality; (c) any indirect, incidental, consequential, special, or punitive damages. TGP''s total aggregate liability to you for any claim relating to the Platform will not exceed the total platform fees TGP actually received from your transactions in the twelve (12) months preceding the claim. Nothing in this section limits liability that cannot be excluded under applicable law.

## 5. Refunds & cancellations

Refunds and cancellations for coaching packages are governed by the **Coach''s** own service agreement and refund policy, not by TGP. You acknowledge that purchases made through the Platform are made **entirely online** and are therefore **not** subject to the U.S. Federal Trade Commission''s "Cooling-Off Rule" (which applies only to certain in-person and off-premises sales and expressly excludes sales made entirely online, by mail, or by telephone). Any voluntary refund window is offered at the Coach''s discretion and stated in the Coach''s agreement. Nothing here waives non-waivable consumer rights that may apply to you under your local law.

## 6. Content, copyright & DMCA

TGP respects intellectual-property rights and complies with the U.S. Digital Millennium Copyright Act (DMCA, 17 U.S.C. §512). TGP acts as an online service provider and maintains a notice-and-takedown process and a policy for terminating repeat infringers. If you believe content on the Platform infringes your copyright, you may send a notice to TGP''s designated agent containing the elements required by §512(c)(3). TGP is not responsible for, and does not endorse, Coach-supplied or user-supplied content; you are responsible for ensuring that anything you upload does not infringe the rights of others.

## 7. Dispute resolution & governing law

This Agreement is governed by the laws of the **State of Delaware, USA**, without regard to its conflict-of-laws rules. Except where prohibited by applicable law, any dispute between you and TGP arising out of or relating to the Platform or this Agreement will be resolved by **final and binding individual arbitration** administered in Delaware, rather than in court, and you and TGP each waive the right to a jury trial and to participate in a class action. You may opt out of arbitration in writing within 30 days of first accepting these terms. This section does not apply to disputes between you and a Coach.

## 8. Acknowledgment

You confirm that you have read and understood this Agreement, that you are at least 18 years old (or the age of majority in your jurisdiction), and that you agree to be bound by it.

---

**CLIENT**

{{client.first_name}} {{client.last_name}} — {{client.email}}

{{client.signature_block}}

Date: {{today}}

**GROWTH PROJECT (PLATFORM)**

{{coach.business_name}}

{{coach.signature_block}}
',
  1,
  '{"client":["first_name","last_name","email","signature_block"],"coach":["business_name","first_name","signature_block"],"package":["name","price","duration"],"platform":["legal_name","jurisdiction","signature_block"],"today":true}'::jsonb,
  true
)
ON CONFLICT ("id") DO NOTHING;

-- Standard Coaching Agreement (standard-coaching-v1.md)
INSERT INTO "ContractTemplate"
  ("id", "coach_id", "is_platform", "name", "body_markdown", "version", "dynamic_fields_json", "requires_signature")
VALUES (
  'b5-tpl-standard-coaching-v1',
  'b5-system-coach-tgp',
  false,
  'Standard Coaching Agreement',
  '---
id: standard-coaching-v1
slug: standard-coaching-agreement
title: Standard Coaching Agreement (1:1)
is_platform: false
version: 1
layer: coach_service
requires_signature: true
parties: Coach ↔ Client
legal_basis:
  - Essential coaching-agreement clauses (scope, fees, cancellation, IP, confidentiality)
  - Non-medical / non-professional-advice disclaimer
  - Limitation of liability
  - ESIGN / UETA electronic signature validity
  - Dispute resolution & governing law
sources:
  - "Essential coaching-agreement clauses (scope, fees, cancellation, confidentiality, IP, liability, disclaimers, termination, dispute resolution): https://sprintlaw.com.au/articles/coaching-agreements-key-clauses-and-legal-risks-for-australian-businesses/"
  - "Coaching disclaimer elements — professional-advice, assumption-of-risk, results, IP, confidentiality (ICF Coaching Agreement framing): https://coactive.com/blog/coaching-disclaimer"
  - "Health coaching agreement structure — purpose, term, responsibilities, renewal: https://www.pandadoc.com/health-coaching-agreement-template/"
  - "Coaching agreement guide & best practices: https://www.universalcoachinstitute.com/coaching-agreement/"
  - "ESIGN/UETA four core elements for a valid e-signature: https://ironcladapp.com/journal/contract-management/electronic-signature-law"
  - "ESIGN Act legal effect of electronic signatures: https://www.purduegloballawschool.edu/blog/news/e-signatures-legal-requirements"
disclaimer: >
  Draft wording prepared by an automated agent WITHOUT licensed legal review.
  FEATURE_CONTRACTS_ENABLED MUST remain OFF in production until reviewed by counsel.
---

# Standard Coaching Agreement

**Between:** **{{coach.business_name}}** (the "**Coach**") and **{{client.first_name}} {{client.last_name}}** (the "**Client**").
**Package:** {{package.name}} — {{package.price}} — {{package.duration}}.
**Effective date:** {{today}}.

This Agreement sets out the terms on which the Coach will provide one-to-one coaching services to the Client. It is between the Coach and the Client directly; Growth Project is a marketplace platform and is not a party to it.

## 1. Scope of services

The Coach will provide one-to-one coaching as described in the **{{package.name}}** package over a period of **{{package.duration}}**. Coaching consists of educational, motivational, and accountability support to help the Client pursue their stated goals. The following are **expressly excluded** and are not part of this engagement: medical or mental-health treatment, diagnosis or therapy, prescription of medication, legal advice, and financial or investment advice. Session length, frequency, format, and any deliverables are as described in the package listing.

## 2. Term, scheduling & rescheduling

This Agreement begins on the effective date and continues for the package duration unless terminated earlier under Section 8. Sessions are booked by mutual arrangement. The Client may reschedule a session with at least 24 hours'' notice; sessions cancelled with less notice, or missed without notice ("no-shows"), are treated as delivered and are forfeited.

## 3. Fees & payment

The fee for the package is **{{package.price}}**, payable through the Growth Project checkout at the time of purchase. Unless expressly stated otherwise in the package, fees are charged upfront for the full package term.

## 4. Cancellation & refunds

Any voluntary refund or cooling-off window, and the conditions that apply to it, are set by the Coach and stated here: the Client may request to cancel before the **first** session is delivered for a refund of the unused portion, less any non-refundable deposit or reasonable charge for work already performed. After services have begun at the Client''s request, refunds are pro-rated to the value of services not yet delivered, at the Coach''s reasonable discretion. This clause does not limit any non-waivable consumer rights the Client has under their local law.

## 5. No professional advice; no guarantee of results

Coaching is **not** medical, mental-health, legal, or financial advice, and the Coach is not acting as the Client''s physician, therapist, attorney, or financial adviser. The Client should consult an appropriately licensed professional for matters requiring such expertise. The Client voluntarily **assumes full responsibility** for their own decisions, actions, health, and results. **No specific outcome is guaranteed**; results depend on the Client''s own effort and circumstances.

## 6. Confidentiality

The Coach will keep information shared by the Client during the engagement confidential and will not disclose it to third parties except: with the Client''s consent; as required by law, valid court order, or subpoena; or where there is an imminent risk of serious harm to the Client or others. The Client agrees to keep the Coach''s proprietary materials and methods confidential.

## 7. Intellectual property

All coaching materials, frameworks, worksheets, recordings, and methodologies provided by the Coach remain the **intellectual property of the Coach**. The Client receives a personal, non-transferable, non-exclusive licence to use them **for the Client''s own personal use only**. Access does not transfer ownership. The Client may not reproduce, distribute, resell, or commercially exploit the materials without the Coach''s written permission.

## 8. Limitation of liability & termination

To the maximum extent permitted by law, the Coach is not liable for indirect or consequential loss, or for the Client''s own decisions made outside the Coach''s control, and the Coach''s total liability under this Agreement will not exceed the fees paid by the Client under it. Either party may terminate for convenience on 14 days'' written notice, or immediately for material breach (including non-payment or breach of confidentiality). Sections 5, 6, 7, and this Section 8 survive termination.

## 9. Electronic signature, governing law & disputes

The parties agree to sign electronically; each electronic signature has the same legal effect as a handwritten signature under ESIGN and UETA. The parties will first attempt to resolve any dispute in good faith. This Agreement is governed by the laws of the Coach''s principal place of business. Headings are for convenience only.

---

**COACH**

{{coach.business_name}} ({{coach.first_name}})

{{coach.signature_block}}

Date: {{today}}

**CLIENT**

{{client.first_name}} {{client.last_name}} — {{client.email}}

{{client.signature_block}}
',
  1,
  '{"client":["first_name","last_name","email","signature_block"],"coach":["business_name","first_name","signature_block"],"package":["name","price","duration"],"platform":["legal_name","jurisdiction","signature_block"],"today":true}'::jsonb,
  true
)
ON CONFLICT ("id") DO NOTHING;

-- Group Program Terms (group-program-v1.md)
INSERT INTO "ContractTemplate"
  ("id", "coach_id", "is_platform", "name", "body_markdown", "version", "dynamic_fields_json", "requires_signature")
VALUES (
  'b5-tpl-group-program-v1',
  'b5-system-coach-tgp',
  false,
  'Group Program Terms',
  '---
id: group-program-v1
slug: group-program-terms
title: Group Program Terms (Cohort / Group Coaching)
is_platform: false
version: 1
layer: coach_service
requires_signature: true
parties: Coach ↔ Client (group participant)
legal_basis:
  - Coaching-agreement clauses adapted to a group/cohort model
  - Individual responsibility & no peer-liability among participants
  - Group confidentiality
  - Non-medical / no-guarantee disclaimer + limitation of liability
  - ESIGN / UETA electronic signature validity
sources:
  - "Coaching-agreement key clauses (scope, fees, cancellation, confidentiality, IP, liability, termination, disputes): https://sprintlaw.com.au/articles/coaching-agreements-key-clauses-and-legal-risks-for-australian-businesses/"
  - "Coaching disclaimer elements — assumption of risk, results-not-guaranteed, IP, confidentiality: https://coactive.com/blog/coaching-disclaimer"
  - "Coaching agreement guide & best practices (group/program framing): https://www.universalcoachinstitute.com/coaching-agreement/"
  - "Coaching agreement structure — purpose, term, responsibilities, renewal: https://www.pandadoc.com/health-coaching-agreement-template/"
  - "ESIGN/UETA four core elements for a valid e-signature: https://ironcladapp.com/journal/contract-management/electronic-signature-law"
  - "ESIGN Act legal effect of electronic records & signatures: https://www.purduegloballawschool.edu/blog/news/e-signatures-legal-requirements"
disclaimer: >
  Draft wording prepared by an automated agent WITHOUT licensed legal review.
  FEATURE_CONTRACTS_ENABLED MUST remain OFF in production until reviewed by counsel.
---

# Group Program Terms

**Between:** **{{coach.business_name}}** (the "**Coach**") and **{{client.first_name}} {{client.last_name}}** (the "**Participant**").
**Program:** {{package.name}} — {{package.price}} — {{package.duration}}.
**Effective date:** {{today}}.

These Terms govern the Participant''s enrollment in a **group / cohort** coaching program delivered by the Coach. Growth Project is a marketplace platform and is not a party to these Terms.

## 1. Nature of the program & scope

The **{{package.name}}** program is delivered to a **group** of participants over **{{package.duration}}**. It consists of group sessions, shared materials, and group accountability support. Because it is a group format, coaching is **not individualized** unless expressly stated, and the Coach allocates time across all participants. Excluded from scope: medical or mental-health treatment, therapy, legal advice, and financial advice.

## 2. Individual responsibility; no peer liability

Each Participant is **solely responsible** for their own decisions, actions, health, and results. The Participant acknowledges that other participants are independent individuals, and **neither the Coach nor any other participant is liable** for the statements, conduct, advice, or outcomes of any other participant. The Participant agrees not to hold the Coach responsible for the behavior of fellow participants.

## 3. Group confidentiality

To make the group a safe space, the Participant agrees to keep confidential any personal information shared by other participants within the program and not to disclose it outside the group. The Coach will keep the Participant''s information confidential except: with consent; as required by law, court order, or subpoena; or where there is an imminent risk of serious harm. The Participant understands the Coach **cannot guarantee** that every other participant will honor confidentiality, and shares within the group at their own discretion.

## 4. Fees, scheduling & cancellation

The program fee is **{{package.price}}**, payable at purchase through the Growth Project checkout. Group sessions run on a **fixed schedule**; missed group sessions are generally **not rescheduled or refunded** because the cohort proceeds on its timetable. Recordings or make-up materials, where offered, are at the Coach''s discretion. The Participant may request to cancel before the program''s **first** session for a refund of the unused portion, less any non-refundable deposit. After the program begins, fees are generally non-refundable given the cohort nature, except as required by non-waivable consumer law.

## 5. No professional advice; no guarantee of results

The program is **not** medical, mental-health, legal, or financial advice. The Participant should consult a licensed professional for such matters. **No specific outcome is guaranteed**; results depend on the Participant''s own effort, participation, and circumstances.

## 6. Intellectual property

All program materials, frameworks, recordings, and methodologies remain the **intellectual property of the Coach**. The Participant receives a personal, non-transferable, non-exclusive licence for their **own personal use only**, and may not record, reproduce, distribute, resell, or share program materials or session recordings with non-participants without the Coach''s written permission.

## 7. Limitation of liability & termination

To the maximum extent permitted by law, the Coach is not liable for indirect or consequential loss or for the Participant''s own decisions, and the Coach''s total liability will not exceed the fees paid by the Participant. The Coach may remove a Participant for disruptive conduct or breach of these Terms. Sections 2, 3, 5, 6, and this Section 7 survive termination.

## 8. Electronic signature, governing law & disputes

The parties agree to sign electronically, with the same legal effect as a handwritten signature under ESIGN and UETA. Disputes will first be addressed in good faith. These Terms are governed by the laws of the Coach''s principal place of business.

---

**COACH**

{{coach.business_name}} ({{coach.first_name}})

{{coach.signature_block}}

Date: {{today}}

**PARTICIPANT**

{{client.first_name}} {{client.last_name}} — {{client.email}}

{{client.signature_block}}
',
  1,
  '{"client":["first_name","last_name","email","signature_block"],"coach":["business_name","first_name","signature_block"],"package":["name","price","duration"],"platform":["legal_name","jurisdiction","signature_block"],"today":true}'::jsonb,
  true
)
ON CONFLICT ("id") DO NOTHING;

-- Course Purchase Terms (course-purchase-v1.md)
INSERT INTO "ContractTemplate"
  ("id", "coach_id", "is_platform", "name", "body_markdown", "version", "dynamic_fields_json", "requires_signature")
VALUES (
  'b5-tpl-course-purchase-v1',
  'b5-system-coach-tgp',
  false,
  'Course Purchase Terms',
  '---
id: course-purchase-v1
slug: course-purchase-terms
title: Course Purchase Terms (Self-Paced Digital Course)
is_platform: false
version: 1
layer: coach_service
requires_signature: true
parties: Coach (Course Provider) ↔ Client (Purchaser)
legal_basis:
  - Self-paced digital-content sale (licence, not transfer of ownership)
  - No-refund-after-access-granted, subject to non-waivable consumer law
  - EU/UK 14-day right of withdrawal + the digital-content exception (express prior consent + acknowledgment of losing withdrawal right)
  - U.S. FTC Cooling-Off Rule does NOT apply to online digital purchases (clarified, not relied upon)
  - DMCA §512 safe-harbor / anti-circumvention & content licence
  - ESIGN / UETA electronic signature validity
sources:
  - "EU right of withdrawal for online businesses — 14-day window & digital-content exception (express consent + acknowledgment): https://www.iubenda.com/en/blog/understanding-the-right-of-withdrawal-in-the-eu-a-guide-for-online-businesses/"
  - "EU right of withdrawal explained — scope, exceptions, trader duties: https://amstlegal.com/eu-right-of-withdrawl-explained/"
  - "Withdrawal-right mechanics & consumer-law fines for non-compliance: https://lawwwing.com/en/the-withdrawal-button-the-legal-fine-you-never-see-coming/"
  - "Italy MIMIT consumer FAQ — Art. 59 Consumer Code digital-content withdrawal exception: https://www.mimit.gov.it/en/media-tools/documents/right-of-withdrawal-frequently-asked-questions-faq"
  - "U.S. Copyright Office DMCA §512 overview (online content / takedown framework): https://www.copyright.gov/512/"
  - "17 U.S.C. §512 — limitations on liability relating to material online: https://www.law.cornell.edu/uscode/text/17/512"
  - "FTC Cooling-Off Rule scope — does NOT cover online purchases: https://consumer.ftc.gov/articles/buyers-remorse-ftcs-cooling-rule-may-help"
  - "ESIGN/UETA four core elements for a valid e-signature: https://ironcladapp.com/journal/contract-management/electronic-signature-law"
disclaimer: >
  Draft wording prepared by an automated agent WITHOUT licensed legal review.
  FEATURE_CONTRACTS_ENABLED MUST remain OFF in production until reviewed by counsel.
---

# Course Purchase Terms

**Between:** **{{coach.business_name}}** (the "**Provider**") and **{{client.first_name}} {{client.last_name}}** (the "**Purchaser**").
**Course:** {{package.name}} — {{package.price}}.
**Effective date:** {{today}}.

These Terms govern the Purchaser''s purchase of and access to a **self-paced digital course** supplied by the Provider. Growth Project operates the marketplace platform that hosts and delivers the course but is **not** a party to these Terms and is **not** the seller of the course content.

## 1. What you are buying

The Purchaser is buying **access to digital course content** — which may include videos, written materials, worksheets, audio, and downloadable resources (the "**Course**"). The Course is **self-paced**: there is no live instruction, scheduled cohort, or individualized coaching unless expressly stated. Access is provided through the Growth Project platform.

## 2. Licence, not ownership

The Purchaser receives a **personal, non-exclusive, non-transferable, revocable licence** to access and use the Course **for their own personal, non-commercial use only**. The Purchaser does **not** acquire ownership of the Course or any intellectual property in it. The Purchaser may not copy, download (except where a download is expressly provided), record, screen-capture, redistribute, resell, sublicense, publicly display, or share the Course or login credentials with any other person. All content, trademarks, and methodologies remain the **intellectual property of the Provider** or its licensors.

## 3. Access term & delivery

Unless a specific access period is stated for **{{package.name}}**, access is granted for the duration the Course remains available on the platform. The Provider may update, improve, or retire Course content; where material content is permanently removed before a stated access period ends, the Provider will provide reasonable substitute access or a pro-rata remedy as required by law.

## 4. Refunds — no refund after access is granted

Because the Course is **digital content delivered immediately**, the Purchaser agrees that **once access to the Course has been granted, the purchase is final and non-refundable**, except where a refund is required by non-waivable consumer-protection law (see Section 5). The Purchaser acknowledges that the U.S. FTC "Cooling-Off Rule" (a 3-day cancellation right) **does not apply** to online or digital purchases, and that no such statutory U.S. cancellation right is created by these Terms.

## 5. EU / UK consumers — 14-day right of withdrawal and the digital-content waiver

If the Purchaser is a consumer in the EU or UK, the Purchaser ordinarily has a **14-day right of withdrawal** to cancel a distance purchase without reason. **However**, for digital content not supplied on a tangible medium, that right is **lost once delivery begins** where the Purchaser has:

1. given **prior express consent** to immediate access before the end of the 14-day period; **and**
2. **acknowledged** that, by doing so, they **lose** their right of withdrawal.

**By signing these Terms and requesting immediate access to the Course, the Purchaser gives that express consent and acknowledges the loss of the 14-day withdrawal right** for the Course content delivered. If the Purchaser does **not** want immediate access, they must not begin the Course and should contact the Provider before accessing any content. This Section does not limit any non-waivable statutory rights (for example, remedies for content that is faulty or not as described).

## 6. Acceptable use & account security

The Purchaser will keep their login credentials confidential and is responsible for activity under their account. Sharing access is a material breach and may result in suspension of access without refund.

## 7. Intellectual-property protection & DMCA

The Course is protected by copyright. The Purchaser will not circumvent any access or copy-protection measures. The Provider and Growth Project comply with the Digital Millennium Copyright Act (DMCA, 17 U.S.C. §512); infringing redistribution of the Course may result in takedown, account termination, and liability. The Purchaser indemnifies the Provider against losses arising from the Purchaser''s unauthorized reproduction or distribution of the Course.

## 8. No professional advice; no guarantee of results

The Course is **educational only** and is **not** medical, mental-health, legal, or financial advice. The Purchaser should consult a licensed professional for such matters. **No specific outcome is guaranteed**; results depend on the Purchaser''s own effort and circumstances.

## 9. Limitation of liability

To the maximum extent permitted by law, the Provider is not liable for indirect or consequential loss, and the Provider''s total liability will not exceed the amount the Purchaser paid for the Course.

## 10. Electronic signature, governing law & disputes

The parties agree to contract and sign **electronically**, with the same legal effect as a handwritten signature under the U.S. ESIGN Act and UETA. Disputes will first be addressed in good faith between the parties. These Terms are governed by the laws of the Provider''s principal place of business, subject to any mandatory consumer-protection law of the Purchaser''s country of residence.

---

**PROVIDER**

{{coach.business_name}} ({{coach.first_name}})

{{coach.signature_block}}

Date: {{today}}

**PURCHASER**

{{client.first_name}} {{client.last_name}} — {{client.email}}

I give express consent to immediate access to the Course and acknowledge that I thereby lose my 14-day right of withdrawal for the digital content delivered (Section 5).

{{client.signature_block}}
',
  1,
  '{"client":["first_name","last_name","email","signature_block"],"coach":["business_name","first_name","signature_block"],"package":["name","price","duration"],"platform":["legal_name","jurisdiction","signature_block"],"today":true}'::jsonb,
  true
)
ON CONFLICT ("id") DO NOTHING;

