/**
 * CoachPackageEditScreen — create or edit a single package, with archive +
 * share actions on edit.
 *
 * Single screen for both modes is intentional: the form is short enough
 * that a separate "create" screen would just be a wrapper around the same
 * inputs. Mode is derived from the `packageId` param: null → create.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  CommonActions,
  type NavigationProp,
  type ParamListBase,
  type RouteProp,
} from "@react-navigation/native";

import {
  coachPackagesApi,
  CoachPackage,
  isLivePackage,
  PackageBillingInterval,
  PackageCreateInput,
  PackageUpdateInput,
} from "../../../api/packagesApi";
import { errorMessage } from "../../../types/common";
import {
  createPackageOnce,
  intentStorageCopy,
  IntentStorageError,
  loadIntent,
  clearIntent,
  type PackageCreateIntent,
} from "../../../lib/coachSetup/packageCreateIntent";
import { describeError } from "../../../lib/coachSetup/errors";
import { mediumTap, successTap, warningTap } from "../../../utils/haptics";
import { track } from "../../../lib/analytics";
import { useTheme } from "../../../theme/ThemeProvider";
import type { SemanticTokens, Tokens } from "../../../theme/tokens";
import { parseDollarsToCents } from "../../../utils/currency";
import {
  packagePriceHelper,
  packagePriceIssue,
} from "../../../utils/packagePrice";
import {
  describePackageSaveFailure,
  type PackageSaveFailure,
} from "../../../utils/packageSaveFailure";
import { signOut } from "../../../services/authActions";
import { buildPackageShareUrl } from "../../../utils/packageShare";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import PackageDetailSurface, {
  type PackageDetailViewModel,
} from "../../client/packageDetail/PackageDetailSurface";

type ParamList = {
  CoachPackageEdit: {
    packageId: string | null;
    // Future: once `GET /v1/coach/packages/:id` is deployed on the
    // backend this nav param can become optional and the screen can
    // refresh from the server on mount. Until then we rely on the list
    // row being passed through nav params so the form has the data it
    // needs.
    initialPackage?: CoachPackage | null;
  };
};
interface Props {
  navigation: NavigationProp<ParamListBase>;
  route: RouteProp<ParamList, "CoachPackageEdit">;
}

/**
 * #321 (Opus B-321-5) + B-347-4: "Make <name> live" publishes the stored row,
 * so it waits for a save while the form has edits.
 */
export const SAVE_BEFORE_PUBLISH = "Save your changes before making this live.";

const INTERVAL_OPTIONS: Array<{
  label: string;
  value: PackageBillingInterval;
}> = [
  { label: "One-time", value: "one_time" },
  { label: "Monthly", value: "monthly" },
  { label: "Quarterly", value: "quarterly" },
  { label: "Yearly", value: "yearly" },
];

export default function CoachPackageEditScreen({ navigation, route }: Props) {
  const { semanticColors, tokens } = useTheme();
  const styles = useMemo(
    () => makeStyles(semanticColors, tokens),
    [semanticColors, tokens],
  );
  const currentUser = useCurrentUser();
  const { packageId, initialPackage } = route.params;
  const isEdit = Boolean(packageId);

  const [loaded, setLoaded] = useState(!isEdit || Boolean(initialPackage));
  const [original, setOriginal] = useState<CoachPackage | null>(
    initialPackage ?? null,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priceText, setPriceText] = useState("");
  const [billingInterval, setBillingInterval] =
    useState<PackageBillingInterval>("monthly");
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  // B-329-1 (B-COACH-5): a create from this editor is durable like the
  // wizard's. Its Idempotency-Key and body are on disk before the request
  // leaves; reopening the editor after a kill resumes that same create.
  const coachId = currentUser?.id ?? null;
  const createIntent = useRef<PackageCreateIntent | null>(null);
  const [resumedCreate, setResumedCreate] = useState(false);
  useEffect(() => {
    if (isEdit) return;
    let live = true;
    void loadIntent(coachId, "editor").then((read) => {
      if (!live || read.kind !== "found" || createIntent.current) return;
      const it = read.intent;
      createIntent.current = it;
      setTitle(it.input.title);
      setDescription(it.input.description ?? "");
      setPriceText((it.input.priceCents / 100).toFixed(2));
      setBillingInterval(it.input.billingInterval);
      setResumedCreate(true);
    });
    return () => {
      live = false;
    };
  }, [isEdit, coachId]);

  useEffect(() => {
    if (!packageId) {
      track("coach_package_create_opened");
      return;
    }
    track("coach_package_edit_opened", { package_id: packageId });
    // Future-route: switch to coachPackagesApi.get(packageId) once
    // `GET /v1/coach/packages/:id` is deployed. Today the row is passed
    // through nav params from CoachPackagesListScreen so the edit screen
    // can render without hitting an undeployed route.
    if (initialPackage) {
      setOriginal(initialPackage);
      setTitle(initialPackage.title ?? "");
      setDescription(initialPackage.description ?? "");
      setPriceText(((initialPackage.priceCents ?? 0) / 100).toFixed(2));
      setBillingInterval(initialPackage.billingInterval);
      setLoaded(true);
      return;
    }
    Alert.alert(
      "Could not load package",
      "Open the package from the list to edit it.",
      [{ text: "OK", onPress: () => navigation.goBack() }],
    );
    setLoaded(true);
  }, [packageId, initialPackage, navigation]);

  const validate = useCallback((): {
    payload: PackageCreateInput | null;
    message: string | null;
  } => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      return { payload: null, message: "Please give the package a name." };
    }
    const cents = parseDollarsToCents(priceText);
    // S-FEE: free (exactly $0, one-time) or $19.99 and up. B-347-1: the free
    // first package from setup keeps saving at its unchanged $0 one-time
    // price; a $0 recurring price is still refused.
    const priceIssue = packagePriceIssue(cents, billingInterval, original);
    if (cents == null || priceIssue) {
      return { payload: null, message: priceIssue };
    }
    // #321 (Opus B-321-4) + B-347-2: trial days and features are not stored
    // by the backend (no package column, no checkout trial), so the editor
    // does not offer them; every input on this screen reaches the request.
    return {
      payload: {
        title: trimmedTitle,
        description: description.trim() || null,
        priceCents: cents,
        billingInterval,
        intervalCount:
          billingInterval === "weekly" ? original?.intervalCount ?? 1 : 1,
      },
      message: null,
    };
  }, [title, description, priceText, billingInterval, original]);

  // #321 (Opus B-321-5) + B-347-4: the form differs from the saved row.
  // Publishing then would put the SAVED terms on sale while the screen shows
  // others, so "Make <name> live" waits until the coach saves.
  const unsaved = useMemo(() => {
    if (!original) return false;
    const cents = parseDollarsToCents(priceText);
    return (
      title.trim() !== (original.title ?? "").trim() ||
      (description.trim() || null) !==
        ((original.description ?? "").trim() || null) ||
      cents !== (original.priceCents ?? 0) ||
      billingInterval !== original.billingInterval
    );
  }, [original, title, description, priceText, billingInterval]);

  // Retry from the failure dialog runs the latest save (current form state).
  const handleSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const showSaveFailure = useCallback(
    (
      f: PackageSaveFailure,
      retry: () => void = () => void handleSaveRef.current(),
    ) => {
      warningTap();
      setError(f.message);
      const close = { text: "Close", style: "cancel" as const };
      const support = {
        text: "Contact support",
        onPress: () => navigation.navigate("SupportInbox"),
      };
      const buttons: Array<{
        text: string;
        style?: "cancel";
        onPress?: () => void;
      }> = [];
      switch (f.action) {
        case "retry":
          buttons.push({ text: "Try again", onPress: retry });
          if (f.support) buttons.push(support);
          buttons.push(close);
          break;
        case "sign_in":
          buttons.push({ text: "Sign in", onPress: () => void signOut() }, close);
          break;
        case "billing":
          buttons.push(
            { text: "Open billing", onPress: () => navigation.navigate("Billing") },
            close,
          );
          break;
        case "back_to_packages":
          buttons.push({
            text: "Back to packages",
            onPress: () => navigation.navigate("CoachPackagesList"),
          });
          if (f.support) buttons.push(support);
          buttons.push(close);
          break;
        default:
          buttons.push({ text: "OK" });
      }
      Alert.alert(f.title, f.message, buttons);
    },
    [navigation],
  );

  // OR-112-16 + B-329-1: one create attempt = one Idempotency-Key and one
  // body, stored on the device before the request leaves (see
  // lib/coachSetup/packageCreateIntent.ts). Every retry, including after the
  // app restarts, re-sends that pair, so the backend returns the package it
  // already made instead of a second one.
  const saveInFlight = useRef(false);

  const handleSave = useCallback(async () => {
    if (saveInFlight.current) return;
    const v = validate();
    if (!v.payload) {
      setError(v.message ?? "Invalid input.");
      warningTap();
      return;
    }
    setError("");
    setSaving(true);
    saveInFlight.current = true;
    try {
      if (isEdit && original) {
        // #321 (B-321-3): billing goes to the backend only when the coach
        // changed it, so a name or description edit never touches the price
        // configuration (no pricing lock, no floor re-check, no cadence
        // drift). A changed cadence is sent and checked against the row the
        // server answers (B-345-1 / B-345-2, PACKAGE_UPDATE_NOT_APPLIED).
        const { billingInterval: nextInterval, intervalCount, ...rest } =
          v.payload;
        const updated: PackageUpdateInput =
          nextInterval !== original.billingInterval
            ? { ...rest, billingInterval: nextInterval, intervalCount }
            : rest;
        const res = await coachPackagesApi.update(original.id, updated);
        setOriginal(res.data);
        successTap();
        Alert.alert("Package updated", "Changes saved.");
      } else {
        const owner = coachId;
        let earlier = createIntent.current;
        if (!earlier) {
          // A failed storage read is not "nothing was sent": stop instead.
          const read = await loadIntent(owner, "editor");
          if (read.kind === "unreadable")
            throw new IntentStorageError("unreadable");
          if (read.kind === "no_account")
            throw new IntentStorageError("no_account");
          if (read.kind === "found") earlier = read.intent;
        }
        let latest: CoachPackage | null = null;
        const created = await createPackageOnce({
          coachId: owner,
          scope: "editor",
          input: v.payload,
          earlier,
          deps: {
            create: async (body, key) => {
              const r = await coachPackagesApi.create(body, key);
              latest = r.data;
              return r;
            },
            update: async (id, body) => {
              const r = await coachPackagesApi.update(id, body);
              latest = r.data;
              return r;
            },
          },
          onIntent: (next) => {
            createIntent.current = next;
          },
        });
        // A create finished in an earlier session (killed before it opened
        // the package): read the row back by saving the same details.
        const res: { data: CoachPackage } = latest
          ? { data: latest }
          : await coachPackagesApi.update(created.packageId, v.payload);
        createIntent.current = null;
        await clearIntent(owner, "editor");
        setResumedCreate(false);
        successTap();
        track("coach_package_created", { package_id: res.data.id });
        // After create, replace the route so back arrow returns to the
        // list rather than the empty create form. Native stack `replace`
        // lives on `@react-navigation/native-stack`, but the screen
        // declares the loose ParamListBase prop type — use the universal
        // CommonActions.reset equivalent via dispatch with a single route.
        navigation.dispatch(
          CommonActions.navigate({
            name: "CoachPackageEdit",
            params: { packageId: res.data.id, initialPackage: res.data },
          }),
        );
        return;
      }
    } catch (err) {
      if (err instanceof IntentStorageError) {
        const copy = intentStorageCopy(err);
        Alert.alert(copy.title, copy.body);
      } else if (isEdit) {
        // #321 (Sol B-321-1): status + machine code decide the message and
        // the next action; unknown failures carry a reference (request_id)
        // and are reported to Sentry. The form keeps the coach's edits.
        showSaveFailure(
          describePackageSaveFailure(err, "update", billingInterval),
        );
      } else {
        // B-329-1: a create is durable (its key and body stay on the device
        // until it lands), so it keeps the wizard's create failure copy.
        const f = describeError(err, "create this package");
        Alert.alert(f.title, f.body);
      }
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [validate, isEdit, original, navigation, coachId, showSaveFailure,
    billingInterval]);
  handleSaveRef.current = handleSave;

  // B-347-3 + S-FEE round 4: a draft made here (or skipped in setup) goes
  // live from the editor (POST :id/publish, the wizard's route; the backend
  // applies the $19.99 floor to a first publish); a live package can be taken
  // off sale. The row the server answers decides what the screen shows next.
  const [publishing, setPublishing] = useState(false);
  const handlePublishToggleRef = useRef<() => Promise<void>>(
    async () => undefined,
  );
  const handlePublishToggle = useCallback(async () => {
    if (!original || publishing) return;
    const mode = isLivePackage(original) ? "unpublish" : "publish";
    // The button is disabled while the form has edits; the line under it
    // says why (SAVE_BEFORE_PUBLISH).
    if (mode === "publish" && unsaved) {
      warningTap();
      return;
    }
    mediumTap();
    setError("");
    setPublishing(true);
    try {
      const res =
        mode === "publish"
          ? await coachPackagesApi.publish(original.id)
          : await coachPackagesApi.unpublish(original.id);
      setOriginal(res.data);
      if (mode === "unpublish") {
        successTap();
        track("coach_package_unpublished", { package_id: original.id });
        Alert.alert(
          "Package unpublished",
          "New clients cannot buy it now. Current clients keep their access.",
        );
      } else if (isLivePackage(res.data)) {
        successTap();
        track("coach_package_published", { package_id: original.id });
        Alert.alert("Package is live", `${res.data.title} is live.`);
      } else {
        Alert.alert(
          "Still a draft",
          `TGP did not confirm ${res.data.title} as live, so clients cannot see it yet. Try again.`,
        );
      }
    } catch (err) {
      showSaveFailure(
        describePackageSaveFailure(err, mode, original.billingInterval),
        () => void handlePublishToggleRef.current(),
      );
    } finally {
      setPublishing(false);
    }
  }, [original, publishing, unsaved, showSaveFailure]);
  handlePublishToggleRef.current = handlePublishToggle;

  const handleArchive = useCallback(() => {
    if (!original) return;
    warningTap();
    Alert.alert(
      "Archive this package?",
      "New clients will no longer be able to subscribe. Existing subscribers are unaffected — they keep access and continue to be billed until they cancel.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: async () => {
            setArchiving(true);
            try {
              const res = await coachPackagesApi.archive(original.id);
              setOriginal(res.data);
              successTap();
              track("coach_package_archived", { package_id: original.id });
            } catch (err) {
              Alert.alert(
                "Could not archive",
                errorMessage(
                  err,
                  "We could not archive the package. Check your connection, then tap Archive again.",
                ),
              );
            } finally {
              setArchiving(false);
            }
          },
        },
      ],
    );
  }, [original]);

  const handleShare = useCallback(async () => {
    if (!original?.shareToken) {
      Alert.alert(
        "Share link not ready yet",
        "The share link will appear here once the package is saved and the backend has minted it.",
      );
      return;
    }
    mediumTap();
    try {
      const url = buildPackageShareUrl(original.shareToken);
      await Share.share({
        message: `Join my coaching package: ${original.title}\n${url}`,
        url,
      });
      track("coach_package_shared", { package_id: original.id });
    } catch {
      // User dismissed; non-actionable.
    }
  }, [original]);

  // The coach's own display name for the preview header. Falls back to a
  // neutral label rather than inventing data — the buyer-facing public route
  // resolves the real coach profile server-side at purchase time.
  const coachDisplayName = useMemo(() => {
    const n =
      currentUser?.name?.trim() ||
      [currentUser?.firstName, currentUser?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
    return n || "You";
  }, [currentUser]);

  // Build the preview view model from the LIVE draft fields so the coach sees
  // their unsaved edits, falling back to saved values where a field is empty.
  // No network round-trip: everything here comes from local state + `original`.
  const previewViewModel = useMemo<PackageDetailViewModel>(() => {
    const cents = parseDollarsToCents(priceText) ?? original?.priceCents ?? 0;
    // B-321-4 + B-347-2: the preview shows only what clients will really see:
    // no typed trial or features (neither reaches the server), only a trial
    // the saved package carries.
    const savedTrial = original?.trialDays ?? null;
    const trialDays =
      billingInterval !== "one_time" && savedTrial ? savedTrial : null;
    return {
      id: original?.id ?? "preview",
      title: title.trim() || "Untitled package",
      description: description.trim() || null,
      priceCents: cents,
      currency: original?.currency ?? "usd",
      billingInterval,
      intervalCount: original?.intervalCount ?? 1,
      trialDays,
      features: [],
      coach: { displayName: coachDisplayName, bio: null },
    };
  }, [
    priceText,
    billingInterval,
    title,
    description,
    original,
    coachDisplayName,
  ]);

  if (!loaded) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={semanticColors.accent} />
      </View>
    );
  }

  const archived = original?.status === "archived";
  const draft = isEdit && !!original && !archived && !isLivePackage(original);
  // S-FEE — inline price rule under the field, as the coach types.
  const priceInlineIssue = priceText.trim()
    ? packagePriceIssue(parseDollarsToCents(priceText), billingInterval, original)
    : null;
  // Pricing is immutable once a package has active subscribers — surface that
  // up-front (helper copy) and again if the backend rejects a price change.
  const pricingLocked = isEdit && (original?.subscriberCount ?? 0) > 0;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons
            name="arrow-back"
            size={24}
            color={semanticColors.textPrimary}
          />
        </TouchableOpacity>
        <Text style={styles.topTitle}>
          {isEdit ? "Edit package" : "New package"}
        </Text>
        <View style={styles.backBtn} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {archived ? (
          <View style={styles.archivedBanner}>
            <Ionicons
              name="archive-outline"
              size={16}
              color={tokens.semantic.warning.icon}
            />
            <Text style={styles.archivedText}>
              This package is archived. It cannot be sold or changed. Create a
              new package instead. Current clients keep their access.
            </Text>
          </View>
        ) : null}

        <Label semanticColors={semanticColors} tokens={tokens}>
          Name
        </Label>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. 12-week transformation"
          style={styles.input}
          placeholderTextColor={semanticColors.textMuted}
          maxLength={120}
        />

        <Label semanticColors={semanticColors} tokens={tokens}>
          Description
        </Label>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What's included? Who is this for?"
          style={[styles.input, styles.inputMultiline]}
          placeholderTextColor={semanticColors.textMuted}
          multiline
          maxLength={1000}
        />

        <Label semanticColors={semanticColors} tokens={tokens}>
          Price (USD)
        </Label>
        <TextInput
          value={priceText}
          onChangeText={setPriceText}
          placeholder="199.00"
          style={styles.input}
          placeholderTextColor={semanticColors.textMuted}
          keyboardType="decimal-pad"
          maxLength={12}
        />
        <Text
          testID="package-price-helper"
          style={
            priceInlineIssue ? styles.priceIssueText : styles.priceHelperText
          }
        >
          {priceInlineIssue ?? packagePriceHelper(billingInterval)}
        </Text>

        <Label semanticColors={semanticColors} tokens={tokens}>
          Billing
        </Label>
        {billingInterval === "weekly" ? (
          <Text style={styles.priceHelperText} testID="package-weekly-note">
            Billed weekly. Leave this as it is to keep weekly billing, or pick
            another option to change it.
          </Text>
        ) : null}
        <View style={styles.segment}>
          {INTERVAL_OPTIONS.map((opt) => {
            const active = billingInterval === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.segmentItem, active && styles.segmentItemActive]}
                onPress={() => setBillingInterval(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={opt.label}
              >
                <Text
                  style={[
                    styles.segmentText,
                    active && styles.segmentTextActive,
                  ]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {pricingLocked ? (
          <View style={styles.lockNotice} accessibilityRole="text">
            <Ionicons
              name="lock-closed"
              size={14}
              color={tokens.semantic.warning.icon}
            />
            <Text style={styles.lockNoticeText}>
              Pricing is locked after subscribers join. Create a new package for
              new pricing.
            </Text>
          </View>
        ) : null}

        {/* B-347-2 + B-321-4: no trial or features input until the backend
            stores them (backend trials + m#338 bring trials back). */}

        {resumedCreate ? (
          <Text style={styles.resumedText} testID="package-edit-resumed">
            Your package from earlier is saved here. Tap Create package to
            finish that same package.
          </Text>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, saving && styles.primaryBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={isEdit ? "Save changes" : "Create package"}
        >
          {saving ? (
            <ActivityIndicator color={semanticColors.textOnAccent} />
          ) : (
            <Text style={styles.primaryBtnText}>
              {isEdit ? "Save changes" : "Create package"}
            </Text>
          )}
        </TouchableOpacity>

        {isEdit && original ? (
          <>
            {draft ? (
              <View testID="package-edit-draft">
                <Text style={styles.resumedText}>
                  {original.title} is saved as a draft. Clients cannot see it
                  until it is live.
                </Text>
                <TouchableOpacity
                  style={[
                    styles.secondaryBtn,
                    (publishing || unsaved) && styles.primaryBtnDisabled,
                  ]}
                  onPress={() => void handlePublishToggle()}
                  disabled={publishing || unsaved}
                  accessibilityRole="button"
                  accessibilityLabel={`Make ${original.title} live`}
                  accessibilityState={{
                    busy: publishing,
                    disabled: publishing || unsaved,
                  }}
                  testID="package-edit-publish"
                >
                  <Text style={styles.secondaryBtnText}>
                    {publishing ? "Making it live" : `Make ${original.title} live`}
                  </Text>
                </TouchableOpacity>
                {unsaved ? (
                  <Text
                    style={styles.resumedText}
                    testID="package-edit-publish-unsaved"
                  >
                    {SAVE_BEFORE_PUBLISH}
                  </Text>
                ) : null}
              </View>
            ) : !archived ? (
              <View testID="package-edit-live">
                <Text
                  style={styles.priceHelperText}
                  testID="package-publish-state"
                >
                  On sale. Unpublishing stops new sales; current clients keep
                  access.
                </Text>
                <TouchableOpacity
                  style={[
                    styles.secondaryBtn,
                    publishing && styles.primaryBtnDisabled,
                  ]}
                  onPress={() => void handlePublishToggle()}
                  disabled={publishing}
                  accessibilityRole="button"
                  accessibilityLabel="Unpublish package"
                  accessibilityState={{ busy: publishing, disabled: publishing }}
                >
                  {publishing ? (
                    <ActivityIndicator color={semanticColors.accent} />
                  ) : (
                    <>
                      <Ionicons
                        name="eye-off-outline"
                        size={18}
                        color={semanticColors.accent}
                      />
                      <Text style={styles.secondaryBtnText}>
                        Unpublish package
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => {
                mediumTap();
                setPreviewOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Preview as buyer"
            >
              <Ionicons
                name="eye-outline"
                size={18}
                color={semanticColors.accent}
              />
              <Text style={styles.secondaryBtnText}>Preview as buyer</Text>
            </TouchableOpacity>

            {original.shareToken ? (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={handleShare}
                accessibilityRole="button"
                accessibilityLabel="Share package link"
              >
                <Ionicons
                  name="share-outline"
                  size={18}
                  color={semanticColors.accent}
                />
                <Text style={styles.secondaryBtnText}>Share link</Text>
              </TouchableOpacity>
            ) : (
              <View
                style={styles.secondaryBtnDisabled}
                accessibilityRole="text"
                accessibilityLabel="Share links are coming soon"
              >
                <Ionicons
                  name="share-outline"
                  size={18}
                  color={semanticColors.textMuted}
                />
                <Text style={styles.secondaryBtnTextDisabled}>
                  Share links are coming soon
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.tertiaryBtn,
                archiving && styles.primaryBtnDisabled,
              ]}
              onPress={handleArchive}
              disabled={archiving || archived}
              accessibilityRole="button"
              accessibilityLabel="Archive package"
            >
              {archiving ? (
                <ActivityIndicator color={tokens.semantic.warning.icon} />
              ) : (
                <>
                  <Ionicons
                    name="archive-outline"
                    size={18}
                    color={
                      archived
                        ? semanticColors.textMuted
                        : tokens.semantic.warning.icon
                    }
                  />
                  <Text
                    style={[
                      styles.tertiaryBtnText,
                      archived && { color: semanticColors.textMuted },
                    ]}
                  >
                    {archived ? "Archived" : "Archive package"}
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {/* PR-17 M2 — entry point to the content-authoring screen.
                Mirrors the subscribers-button nav pattern below. */}
            <TouchableOpacity
              style={styles.linkBtn}
              onPress={() =>
                navigation.navigate("CoachPackageContents", {
                  packageId: original.id,
                  title: original.title,
                })
              }
              accessibilityRole="button"
              accessibilityLabel="Manage content"
            >
              <Text style={styles.linkBtnText}>Manage content</Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={semanticColors.accent}
              />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.linkBtn}
              onPress={() =>
                navigation.navigate("CoachPackageSubscribers", {
                  packageId: original.id,
                  title: original.title,
                })
              }
              accessibilityRole="button"
              accessibilityLabel="View subscribers"
            >
              <Text style={styles.linkBtnText}>
                View subscribers ({original.subscriberCount})
              </Text>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={semanticColors.accent}
              />
            </TouchableOpacity>
          </>
        ) : null}
      </ScrollView>

      <Modal
        visible={previewOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPreviewOpen(false)}
      >
        <View style={styles.container}>
          <View style={styles.topBar}>
            <TouchableOpacity
              onPress={() => setPreviewOpen(false)}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Close preview"
            >
              <Ionicons
                name="close"
                size={24}
                color={semanticColors.textPrimary}
              />
            </TouchableOpacity>
            <Text style={styles.topTitle}>Buyer preview</Text>
            <View style={styles.backBtn} />
          </View>
          {/* coachPreview mode: checkout CTA is disabled and never calls a
              checkout session. No network fetch — the view model is built from
              the live draft + saved `original`. */}
          <PackageDetailSurface
            package={previewViewModel}
            mode="coachPreview"
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function Label({
  children,
  semanticColors,
  tokens,
}: {
  children: React.ReactNode;
  semanticColors: SemanticTokens;
  tokens: Tokens;
}) {
  return (
    <Text
      style={{
        marginTop: 16,
        marginBottom: 6,
        fontSize: 12,
        color: semanticColors.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        fontWeight: "500",
      }}
    >
      {children}
    </Text>
  );
}

const makeStyles = (semanticColors: SemanticTokens, tokens: Tokens) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: semanticColors.bgPrimary },
    center: { justifyContent: "center", alignItems: "center" },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 56,
      paddingBottom: 12,
    },
    backBtn: {
      width: 40,
      height: 40,
      justifyContent: "center",
      alignItems: "center",
    },
    topTitle: {
      fontSize: 18,
      fontWeight: "500",
      color: semanticColors.textPrimary,
    },
    content: { paddingHorizontal: 24, paddingBottom: 60 },
    archivedBanner: {
      flexDirection: "row",
      gap: 8,
      padding: 10,
      borderRadius: 4,
      backgroundColor: tokens.semantic.warning.bg,
      marginBottom: 12,
    },
    archivedText: { flex: 1, fontSize: 12, color: semanticColors.textPrimary },
    lockNotice: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      marginTop: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: tokens.radius.lg,
      borderWidth: 1,
      borderColor: tokens.semantic.warning.border,
      backgroundColor: tokens.semantic.warning.bg,
    },
    lockNoticeText: {
      flex: 1,
      fontSize: 12,
      lineHeight: 17,
      color: semanticColors.textPrimary,
    },
    input: {
      backgroundColor: semanticColors.bgSurface,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 4,
      fontSize: 15,
      color: semanticColors.textPrimary,
    },
    inputMultiline: {
      minHeight: 80,
      textAlignVertical: "top",
    },
    segment: {
      flexDirection: "row",
      backgroundColor: semanticColors.bgSurface,
      borderRadius: 4,
      padding: 4,
      gap: 4,
    },
    segmentItem: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 2,
      alignItems: "center",
    },
    segmentItemActive: { backgroundColor: semanticColors.accent },
    segmentText: {
      fontSize: 12,
      color: semanticColors.textMuted,
      fontWeight: "500",
    },
    segmentTextActive: { color: semanticColors.textOnAccent },
    primaryBtn: {
      marginTop: 28,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: semanticColors.accent,
      paddingVertical: 14,
      borderRadius: 2,
    },
    primaryBtnDisabled: { opacity: 0.6 },
    primaryBtnText: {
      color: semanticColors.textOnAccent,
      fontSize: 15,
      fontWeight: "500",
    },
    secondaryBtn: {
      marginTop: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      borderRadius: 2,
      borderWidth: 1,
      borderColor: semanticColors.accent,
    },
    secondaryBtnText: {
      color: semanticColors.accent,
      fontSize: 15,
      fontWeight: "500",
    },
    secondaryBtnDisabled: {
      marginTop: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      borderRadius: 2,
      borderWidth: 1,
      borderColor: semanticColors.border,
      backgroundColor: semanticColors.bgSurface,
    },
    secondaryBtnTextDisabled: {
      color: semanticColors.textMuted,
      fontSize: 14,
      fontWeight: "400",
    },
    tertiaryBtn: {
      marginTop: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      borderRadius: 2,
    },
    tertiaryBtnText: {
      color: tokens.semantic.warning.icon,
      fontSize: 14,
      fontWeight: "500",
    },
    linkBtn: {
      marginTop: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
    },
    linkBtnText: {
      fontSize: 14,
      color: semanticColors.accent,
      fontWeight: "500",
    },
    errorText: {
      marginTop: 12,
      color: tokens.colors.error,
      fontSize: 13,
    },
    resumedText: {
      marginTop: 12,
      color: semanticColors.textMuted,
      fontSize: 13,
    },
    priceHelperText: {
      marginTop: 6,
      fontSize: 12,
      color: semanticColors.textMuted,
    },
    priceIssueText: { marginTop: 6, fontSize: 12, color: tokens.colors.error },
  });
