/**
 * CoachWizardNavigator — coach setup wizard (S-COACH).
 *
 * Shown when GET /coach/onboarding returns { is_complete: false }.
 *   1. Practice basics      (saved to backend step 1)
 *   2. Get paid             Stripe-hosted Express onboarding collects bank
 *                           account and ID; truthful status on return
 *   3. First package        prefilled; free or $19.99 and up (backend #629)
 *   4. Invite first client  link, share sheet, copy, QR code
 *   5. Ready                checklist, then POST /coach/onboarding/complete
 * The backend keeps 6 sequential steps; advanceWizardTo walks it forward one
 * step at a time. Stripe, package and invite can each be done later from the
 * Home checklist, so the wizard never traps a coach.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { authEvents } from "../utils/authEvents";
import { prefsStorage } from "../storage/mmkv";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme, ThemeColors } from "../theme/ThemeProvider";
import {
  advanceWizardTo,
  stepBlob,
  coachSetupApi,
  type ConnectView,
} from "../api/coachSetupApi";
import {
  coachPackagesApi,
  isLivePackage,
  type CoachPackage,
} from "../api/packagesApi";
import { describeError, type FriendlyError } from "../lib/coachSetup/errors";
import GetPaidPanel from "../components/coach/setup/GetPaidPanel";
import FirstPackageForm, {
  type CreatedPackage,
} from "../components/coach/setup/FirstPackageForm";
import InviteShareCard from "../components/coach/setup/InviteShareCard";
import SetupNotice from "../components/coach/setup/SetupNotice";
import { useCurrentUser } from "../hooks/useCurrentUser";
import {
  loadSetupStatus,
  type SetupSnapshot,
} from "../lib/coachSetup/setupStatus";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CoachWizardParamList = {
  CoachWizardStep1: undefined;
  CoachWizardStep2: undefined;
  CoachWizardStep3: undefined;
  CoachWizardStep4: undefined;
  CoachWizardStep5: undefined;
};

const UI_STEPS = 5;
const BACKEND_FINAL_STEP = 6;

export const PRACTICE_FOCUS_OPTIONS = [
  "Strength",
  "Nutrition",
  "Weight loss",
  "Mobility",
  "Lifestyle",
  "Sports performance",
] as const;

// R15: scope to user id. Informational only; RootNavigator reads the
// canonical state from GET /coach/onboarding.
const MMKV_COMPLETE_KEY_BASE = "coach.onboarding.is_complete";

async function persistWizardCompleteFlag(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem("user_data");
    const id = raw ? (JSON.parse(raw) as { id?: string })?.id : null;
    if (!id) return;
    await prefsStorage.set(`${MMKV_COMPLETE_KEY_BASE}:${id}`, "true");
  } catch {
    // Best effort: RootNavigator's API check is the source of truth.
  }
}

// ─── Wizard state shared across steps ───────────────────────────────────────

interface WizardState {
  practiceName: string;
  focus: string[];
  connect: ConnectView | null;
  pkg: CreatedPackage | null;
  existingPackageTitle: string | null;
  invited: boolean;
}

interface WizardCtx {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
}

const WizardContext = createContext<WizardCtx | null>(null);

function useWizard(): WizardCtx {
  const ctx = useContext(WizardContext);
  if (!ctx)
    throw new Error("useWizard must be used inside CoachWizardNavigator");
  return ctx;
}

/** Save a step and move on; shows specific copy when the save fails. */
function useStepSaver(step: number) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const save = useCallback(
    async (data: Record<string, unknown>, next: () => void) => {
      setSaving(true);
      setError(null);
      try {
        await advanceWizardTo(step, data);
        next();
      } catch (err) {
        setError(describeError(err, "save this step"));
      } finally {
        setSaving(false);
      }
    },
    [step],
  );
  return { saving, error, save };
}

// ─── Shared step layout ───────────────────────────────────────────────────────

interface StepLayoutProps {
  stepNumber: number;
  totalSteps: number;
  heading: string;
  body: string;
  ctaLabel: string;
  onCta: () => void;
  ctaDisabled?: boolean;
  onBack?: () => void;
  children?: React.ReactNode;
}

function StepLayout({
  stepNumber,
  totalSteps,
  heading,
  body,
  ctaLabel,
  onCta,
  ctaDisabled,
  onBack,
  children,
}: StepLayoutProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
      >
        {/* Step indicator */}
        <View style={styles.stepIndicator}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i < stepNumber - 1 && styles.dotComplete,
                i === stepNumber - 1 && styles.dotActive,
              ]}
            />
          ))}
        </View>

        <Text style={styles.headline} accessibilityRole="header">
          {heading}
        </Text>
        <Text style={styles.subtext}>{body}</Text>

        {children ? (
          <View style={styles.childrenContainer}>{children}</View>
        ) : null}

        <View style={{ flex: 1 }} />

        <TouchableOpacity
          style={[styles.primaryBtn, ctaDisabled && styles.primaryBtnDisabled]}
          onPress={onCta}
          disabled={ctaDisabled}
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          testID={`wizard-step-${stepNumber}-cta`}
        >
          <Text style={styles.primaryBtnText}>{ctaLabel}</Text>
        </TouchableOpacity>

        {onBack ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            testID={`wizard-step-${stepNumber}-back`}
          >
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Step 1: practice basics ─────────────────────────────────────────────────

type Step1Props = {
  navigation: NativeStackNavigationProp<
    CoachWizardParamList,
    "CoachWizardStep1"
  >;
};

function CoachWizardStep1({ navigation }: Step1Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { state, patch } = useWizard();
  const { saving, error, save } = useStepSaver(1);
  const [name, setName] = useState(state.practiceName);
  const toggle = (f: string) =>
    patch({
      focus: state.focus.includes(f)
        ? state.focus.filter((x) => x !== f)
        : [...state.focus, f],
    });
  const valid = name.trim().length > 0;
  return (
    <StepLayout
      stepNumber={1}
      totalSteps={UI_STEPS}
      heading="Your practice"
      body="Tell us what to call your coaching and what you focus on. We use this to set up your first package."
      ctaLabel="Continue"
      ctaDisabled={!valid || saving}
      onCta={() => {
        patch({ practiceName: name.trim() });
        void save(
          {
            practice_name: name.trim(),
            focus: state.focus,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          () => navigation.navigate("CoachWizardStep2"),
        );
      }}
    >
      <Text style={styles.fieldLabel} nativeID="practice-name-label">
        Practice name
      </Text>
      <TextInput
        value={name}
        onChangeText={setName}
        style={styles.input}
        accessibilityLabel="Practice name"
        accessibilityLabelledBy="practice-name-label"
        placeholder="For example, Northside Strength"
        placeholderTextColor={colors.textMuted}
        maxLength={80}
        testID="wizard-practice-name"
      />
      <Text style={styles.fieldLabel}>What you focus on</Text>
      <View
        style={styles.chips}
        accessibilityLabel="What you focus on. Choose any that fit."
      >
        {PRACTICE_FOCUS_OPTIONS.map((f) => {
          const on = state.focus.includes(f);
          return (
            <TouchableOpacity
              key={f}
              onPress={() => toggle(f)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={f}
              testID={`wizard-focus-${f}`}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {f}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {error ? (
        <SetupNotice error={error} testID="wizard-step-1-error" />
      ) : null}
    </StepLayout>
  );
}

// ─── Step 2: get paid ────────────────────────────────────────────────────────

type Step2Props = {
  navigation: NativeStackNavigationProp<
    CoachWizardParamList,
    "CoachWizardStep2"
  >;
};

function CoachWizardStep2({ navigation }: Step2Props) {
  const { state, patch } = useWizard();
  const { saving, error, save } = useStepSaver(2);
  const ready = state.connect?.state === "active";
  const next = () =>
    void save({ connect_state: state.connect?.state ?? "unknown" }, () =>
      navigation.navigate("CoachWizardStep3"),
    );
  return (
    <StepLayout
      stepNumber={2}
      totalSteps={UI_STEPS}
      heading="Get paid"
      body="Clients pay you by card. Stripe, our payments partner, holds your bank and ID details so TGP never sees them."
      ctaLabel={ready ? "Continue" : "Continue without payouts for now"}
      ctaDisabled={saving}
      onCta={next}
      onBack={() => navigation.goBack()}
    >
      <GetPaidPanel
        onChange={(v) => patch({ connect: v })}
        testID="wizard-get-paid"
      />
      {!ready ? (
        <SmallNote text="You can finish this later from the checklist on your Home screen. Free packages work without Stripe." />
      ) : null}
      {error ? (
        <SetupNotice error={error} testID="wizard-step-2-error" />
      ) : null}
    </StepLayout>
  );
}

// ─── Step 3: first package ───────────────────────────────────────────────────

type Step3Props = {
  navigation: NativeStackNavigationProp<
    CoachWizardParamList,
    "CoachWizardStep3"
  >;
};

function CoachWizardStep3({ navigation }: Step3Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { state, patch } = useWizard();
  const { saving, error, save } = useStepSaver(3);
  const [checking, setChecking] = useState(true);
  const [listError, setListError] = useState<FriendlyError | null>(null);
  const [draft, setDraft] = useState<CoachPackage | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<FriendlyError | null>(null);

  // C-329-1: only a live package (active, not archived, published) counts.
  // A draft is offered to publish; it is never shown as live.
  const check = useCallback(async () => {
    setChecking(true);
    setListError(null);
    try {
      const res = await coachPackagesApi.list();
      const live = res.data.find(isLivePackage);
      if (live) {
        patch({ existingPackageTitle: live.title });
        setDraft(null);
      } else {
        setDraft(
          res.data.find((p) => p.status !== "archived" && !p.archivedAt) ??
            null,
        );
      }
    } catch (err) {
      setListError(describeError(err, "check your packages"));
    } finally {
      setChecking(false);
    }
  }, [patch]);

  useEffect(() => {
    void check();
  }, [check]);

  const publishDraft = async () => {
    if (!draft) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await coachSetupApi.publishPackage(draft.id);
      patch({ existingPackageTitle: draft.title });
      setDraft(null);
    } catch (err) {
      setPublishError(describeError(err, "make your package live"));
    } finally {
      setPublishing(false);
    }
  };

  const done = state.pkg !== null || state.existingPackageTitle !== null;
  const goNext = () =>
    void save(
      state.pkg
        ? {
            package_id: state.pkg.id,
            price_cents: state.pkg.priceCents,
            billing: state.pkg.billingInterval,
          }
        : { package_skipped: !done },
      () => navigation.navigate("CoachWizardStep4"),
    );
  const title = state.practiceName
    ? `${state.practiceName} coaching`
    : "1:1 coaching";
  return (
    <StepLayout
      stepNumber={3}
      totalSteps={UI_STEPS}
      heading="Your first package"
      body="This is what a client signs up for. We filled in a starting point you can change any time."
      ctaLabel={done ? "Continue" : "Skip for now"}
      ctaDisabled={saving}
      onCta={goNext}
      onBack={() => navigation.goBack()}
    >
      {checking ? (
        <ActivityIndicator accessibilityLabel="Checking your packages" />
      ) : listError ? (
        <SetupNotice
          error={listError}
          onRetry={() => void check()}
          testID="wizard-package-list-error"
        />
      ) : state.pkg ? (
        <SmallNote
          testID="wizard-package-created"
          text={
            state.pkg.priceCents === 0
              ? `${state.pkg.title} is live and free. Clients who join with your invite link get it straight away.`
              : `${state.pkg.title} is live at $${(state.pkg.priceCents / 100).toFixed(2)}${
                  state.pkg.billingInterval === "monthly" ? " a month" : ""
                }.`
          }
        />
      ) : state.existingPackageTitle ? (
        <SmallNote
          testID="wizard-package-existing"
          text={`You already have a package, ${state.existingPackageTitle}. You can add more from Packages later.`}
        />
      ) : (
        <>
          {draft ? (
            <View testID="wizard-package-draft">
              <SmallNote
                text={`${draft.title} is saved as a draft. Clients cannot see it until it is live.`}
              />
              <TouchableOpacity
                onPress={() => void publishDraft()}
                disabled={publishing}
                accessibilityRole="button"
                accessibilityLabel={`Make ${draft.title} live`}
                accessibilityState={{ busy: publishing, disabled: publishing }}
                testID="wizard-package-draft-publish"
                style={styles.linkBtn}
              >
                <Text style={styles.linkBtnText}>
                  {publishing ? "Making it live" : `Make ${draft.title} live`}
                </Text>
              </TouchableOpacity>
              {publishError ? (
                <SetupNotice
                  error={publishError}
                  onRetry={() => void publishDraft()}
                  testID="wizard-package-draft-error"
                />
              ) : null}
              <SmallNote text="Or create a new package below." />
            </View>
          ) : null}
          <FirstPackageForm
            defaultTitle={title}
            defaultDescription={
              state.focus.length
                ? `Coaching for ${state.focus.join(", ").toLowerCase()}.`
                : null
            }
            chargesEnabled={state.connect?.chargesEnabled === true}
            onCreated={(pkg) => patch({ pkg })}
            testID="wizard-first-package"
          />
        </>
      )}
      {error ? (
        <SetupNotice error={error} testID="wizard-step-3-error" />
      ) : null}
    </StepLayout>
  );
}

// ─── Step 4: invite first client ─────────────────────────────────────────────

type Step4Props = {
  navigation: NativeStackNavigationProp<
    CoachWizardParamList,
    "CoachWizardStep4"
  >;
};

function CoachWizardStep4({ navigation }: Step4Props) {
  const { state, patch } = useWizard();
  const { saving, error, save } = useStepSaver(4);
  return (
    <StepLayout
      stepNumber={4}
      totalSteps={UI_STEPS}
      heading="Invite your first client"
      body="Send your link, or let them scan the QR code. When they join, they appear in your client list."
      ctaLabel={state.invited ? "Continue" : "Continue without inviting"}
      ctaDisabled={saving}
      onCta={() =>
        void save({ invite_shared: state.invited }, () =>
          navigation.navigate("CoachWizardStep5"),
        )
      }
      onBack={() => navigation.goBack()}
    >
      <InviteShareCard
        onShared={() => patch({ invited: true })}
        packageName={state.pkg?.title ?? state.existingPackageTitle}
        testID="wizard-invite"
      />
      {error ? (
        <SetupNotice error={error} testID="wizard-step-4-error" />
      ) : null}
    </StepLayout>
  );
}

// ─── Step 5: ready ───────────────────────────────────────────────────────────

type Step5Props = {
  navigation: NativeStackNavigationProp<
    CoachWizardParamList,
    "CoachWizardStep5"
  >;
};

function CoachWizardStep5({ navigation }: Step5Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { state } = useWizard();
  const user = useCurrentUser();
  const coachId = user?.id ?? null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  // C-329-3: read the server on mount. When the wizard resumes on this
  // step, the in-memory state from earlier steps is empty, so the ticks
  // must come from the same routes the Home checklist uses.
  const [snap, setSnap] = useState<SetupSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const check = useCallback(async () => {
    if (!coachId) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      setSnap(await loadSetupStatus(coachId));
    } finally {
      setChecking(false);
    }
  }, [coachId]);
  useEffect(() => {
    void check();
  }, [check]);
  const connectState = snap?.connect?.state ?? state.connect?.state ?? null;
  const hasPackage =
    state.pkg !== null ||
    state.existingPackageTitle !== null ||
    (snap?.livePackageTitle ?? "") !== "";
  const hasClient = snap?.hasClient === true;
  const shared = state.invited || snap?.sharedLink === true;
  const items = [
    { label: "Practice set up", done: state.practiceName.length > 0 },
    { label: "Stripe ready to pay you", done: connectState === "active" },
    { label: "First package live", done: hasPackage },
    {
      label: hasClient
        ? "First client joined"
        : shared
          ? "Invite link shared, waiting for your first client to join"
          : "First client invited",
      done: hasClient,
    },
  ];
  const finish = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await advanceWizardTo(BACKEND_FINAL_STEP);
      await coachSetupApi.complete();
      await persistWizardCompleteFlag();
      authEvents.emit();
    } catch (err) {
      setError(describeError(err, "finish setup"));
      setSubmitting(false);
    }
  };
  return (
    <StepLayout
      stepNumber={5}
      totalSteps={UI_STEPS}
      heading="You are ready to coach"
      body="Anything still open stays on your Home checklist, and we mark your first client payment with you when it lands."
      ctaLabel="Go to my dashboard"
      ctaDisabled={submitting}
      onCta={finish}
      onBack={() => navigation.goBack()}
    >
      {checking ? (
        <ActivityIndicator
          color={colors.primary}
          accessibilityLabel="Checking your setup"
          testID="wizard-step-5-checking"
        />
      ) : null}
      {snap && snap.errors.length > 0 ? (
        <SetupNotice
          error={snap.errors[0]}
          onRetry={checking ? undefined : () => void check()}
          testID="wizard-step-5-status-error"
        />
      ) : null}
      <View accessibilityRole="list">
        {items.map((it) => (
          <View
            key={it.label}
            style={styles.checkRow}
            accessible
            accessibilityLabel={`${it.label}. ${it.done ? "Done" : "Still to do"}`}
          >
            <View style={[styles.checkDot, it.done && styles.checkDotDone]} />
            <Text style={styles.checkText}>
              {it.label}
              {it.done ? "" : " (still to do)"}
            </Text>
          </View>
        ))}
      </View>
      {error ? (
        <SetupNotice
          error={error}
          onRetry={finish}
          testID="wizard-step-5-error"
        />
      ) : null}
    </StepLayout>
  );
}

function SmallNote({ text, testID }: { text: string; testID?: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Text style={styles.note} testID={testID}>
      {text}
    </Text>
  );
}

// ─── Navigator ────────────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<CoachWizardParamList>();

/** Map the backend step (1..6) to the screen to resume on. Exported for tests. */
export function resumeRoute(currentStep: number): keyof CoachWizardParamList {
  if (currentStep >= 5) return "CoachWizardStep5";
  if (currentStep === 4) return "CoachWizardStep4";
  if (currentStep === 3) return "CoachWizardStep3";
  if (currentStep === 2) return "CoachWizardStep2";
  return "CoachWizardStep1";
}

export default function CoachWizardNavigator() {
  const { colors } = useTheme();
  const [initial, setInitial] = useState<keyof CoachWizardParamList | null>(
    null,
  );
  const [state, setState] = useState<WizardState>({
    practiceName: "",
    focus: [],
    connect: null,
    pkg: null,
    existingPackageTitle: null,
    invited: false,
  });
  const patch = useCallback(
    (p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })),
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      let practiceName = "";
      let focus: string[] = [];
      let step = 1;
      try {
        const raw = await AsyncStorage.getItem("user_data");
        const u = raw ? (JSON.parse(raw) as { name?: string }) : null;
        if (u?.name) practiceName = u.name;
      } catch {
        // No cached profile: the coach types the name.
      }
      try {
        const progress = await coachSetupApi.progress();
        step = progress.currentStep;
        const s1 = stepBlob(progress.stepData, 1);
        if (s1 && typeof s1.practice_name === "string")
          practiceName = s1.practice_name;
        if (s1 && Array.isArray(s1.focus))
          focus = s1.focus.filter((x): x is string => typeof x === "string");
      } catch {
        // Not started yet (404) or offline: begin at step 1; saving retries.
      }
      if (!alive) return;
      setState((s) => ({ ...s, practiceName, focus }));
      setInitial(resumeRoute(step));
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ctx = useMemo(() => ({ state, patch }), [state, patch]);
  if (!initial) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator
          color={colors.primary}
          accessibilityLabel="Loading your setup"
        />
      </View>
    );
  }
  return (
    <WizardContext.Provider value={ctx}>
      <Stack.Navigator
        initialRouteName={initial}
        screenOptions={{ headerShown: false, animation: "slide_from_right" }}
      >
        <Stack.Screen name="CoachWizardStep1" component={CoachWizardStep1} />
        <Stack.Screen name="CoachWizardStep2" component={CoachWizardStep2} />
        <Stack.Screen name="CoachWizardStep3" component={CoachWizardStep3} />
        <Stack.Screen name="CoachWizardStep4" component={CoachWizardStep4} />
        <Stack.Screen name="CoachWizardStep5" component={CoachWizardStep5} />
      </Stack.Navigator>
    </WizardContext.Provider>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    inner: {
      flexGrow: 1,
      paddingHorizontal: 24,
      paddingTop: 32,
      paddingBottom: 24,
    },
    stepIndicator: { flexDirection: "row", gap: 8, marginBottom: 28 },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.border,
    },
    dotActive: { backgroundColor: colors.primary, width: 24 },
    dotComplete: { backgroundColor: colors.primary },
    headline: {
      fontFamily: "CormorantGaramond_400Regular",
      fontSize: 32,
      lineHeight: 36,
      color: colors.textPrimary,
      marginBottom: 12,
    },
    subtext: {
      fontFamily: "Inter_400Regular",
      fontSize: 15,
      color: colors.textSecondary,
      lineHeight: 22,
      marginBottom: 16,
    },
    childrenContainer: { marginBottom: 16 },
    primaryBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 16,
      alignItems: "center",
      marginTop: 16,
    },
    primaryBtnDisabled: { opacity: 0.5 },
    linkBtn: { minHeight: 44, justifyContent: "center" },
    linkBtnText: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 15,
      color: colors.primary,
    },
    primaryBtnText: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 14,
      color: colors.textOnPrimary,
      letterSpacing: 1.2,
    },
    backBtn: {
      paddingVertical: 12,
      alignSelf: "flex-start",
      marginTop: 4,
    },
    backText: {
      fontFamily: "Inter_500Medium",
      fontSize: 13,
      color: colors.textSecondary,
    },
    fieldLabel: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 13,
      color: colors.textSecondary,
      marginTop: 12,
      marginBottom: 6,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      minHeight: 48,
      paddingHorizontal: 12,
      fontFamily: "Inter_400Regular",
      fontSize: 16,
      color: colors.textPrimary,
      backgroundColor: colors.surface,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      borderWidth: 1,
      borderColor: colors.border,
      minHeight: 44,
      paddingHorizontal: 14,
      justifyContent: "center",
    },
    chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: {
      fontFamily: "Inter_500Medium",
      fontSize: 14,
      color: colors.textPrimary,
    },
    chipTextOn: { color: colors.textOnPrimary },
    note: {
      fontFamily: "Inter_400Regular",
      fontSize: 14,
      lineHeight: 20,
      color: colors.textSecondary,
      marginTop: 8,
    },
    checkRow: { flexDirection: "row", alignItems: "center", minHeight: 36 },
    checkDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.primary,
      marginRight: 12,
    },
    checkDotDone: { backgroundColor: colors.primary },
    checkText: {
      fontFamily: "Inter_400Regular",
      fontSize: 15,
      color: colors.textPrimary,
    },
    errorText: {
      fontFamily: "Inter_400Regular",
      fontSize: 13,
      color: colors.error,
      lineHeight: 19,
      marginTop: 8,
      marginBottom: 8,
    },
  });
