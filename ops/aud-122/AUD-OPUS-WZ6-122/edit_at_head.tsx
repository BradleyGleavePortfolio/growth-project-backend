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
import { errorCode, errorMessage } from "../../../types/common";
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

// B-347-4: the editable terms as one comparable value.
const formKey = (...fields: string[]) => JSON.stringify(fields);

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
  const [trialText, setTrialText] = useState("");
  const [featuresText, setFeaturesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  // B-347-4: "Make live" publishes the stored row, so it waits until the
  // terms on screen are the terms last loaded or saved.
  const [savedForm, setSavedForm] = useState<string | null>(null);
  const formNow = formKey(title, description, priceText, billingInterval, featuresText);
  const unsaved = savedForm !== null && formNow !== savedForm;
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
      setTrialText(it.input.trialDays ? String(it.input.trialDays) : "");
      setFeaturesText((it.input.features ?? []).join("\n"));
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
      setTrialText(
        initialPackage.trialDays ? String(initialPackage.trialDays) : "",
      );
      setFeaturesText((initialPackage.features ?? []).join("\n"));
      setSavedForm(
        formKey(
          initialPackage.title ?? "",
          initialPackage.description ?? "",
          ((initialPackage.priceCents ?? 0) / 100).toFixed(2),
          initialPackage.billingInterval,
          (initialPackage.features ?? []).join("\n"),
        ),
      );
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
    if (cents == null) {
      return { payload: null, message: "Enter a valid price." };
    }
    // B-347-1: the free one-time package from setup keeps its $0 price when
    // the coach edits its name or details. A new $0 price is still refused.
    const freeKept =
      isEdit && original?.priceCents === 0 && billingInterval === "one_time";
    if (cents === 0 && !freeKept) {
      return {
        payload: null,
        message:
          original?.priceCents === 0
            ? "Free packages are one-time. Choose One-time, or enter a price."
            : "Price must be greater than zero. Use a free invite code for comps.",
      };
    }
    const features = featuresText
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    let trialDays: number | null = null;
    if (trialText.trim()) {
      const n = Number(trialText.trim());
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        return {
          payload: null,
          message: "Trial days must be a whole number between 0 and 365.",
        };
      }
      trialDays = n;
    }
    return {
      payload: {
        title: trimmedTitle,
        description: description.trim() || null,
        priceCents: cents,
        billingInterval,
        intervalCount: 1,
        trialDays,
        features,
      },
      message: null,
    };
  }, [title, description, priceText, billingInterval, trialText, featuresText,
    isEdit, original]);

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
        const updated: PackageUpdateInput = v.payload;
        const res = await coachPackagesApi.update(original.id, updated);
        setOriginal(res.data);
        setSavedForm(formNow);
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
      const code = errorCode(err);
      if (err instanceof IntentStorageError) {
        const copy = intentStorageCopy(err);
        Alert.alert(copy.title, copy.body);
      } else if (code === "PACKAGES_NOT_CONFIGURED") {
        Alert.alert(
          "Packages not enabled yet",
          errorMessage(
            err,
            "The packages backend module is not deployed in this environment.",
          ),
        );
      } else if (code === "PACKAGE_PRICING_LOCKED") {
        warningTap();
        Alert.alert(
          "Pricing is locked",
          "Pricing is locked because this package already has active subscribers. Create a new package for new pricing; you can still edit name, description, deliverables, and availability.",
        );
      } else {
        const f = describeError(
          err,
          isEdit ? "save this package" : "create this package",
        );
        Alert.alert(f.title, f.body);
      }
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [validate, isEdit, original, navigation, coachId, formNow]);

  // B-347-3: a draft made here (or skipped in setup) can go live from the
  // editor with the wizard's publish call; the row the server answers decides
  // what the screen shows next.
  const [publishing, setPublishing] = useState(false);
  const handlePublish = useCallback(async () => {
    if (!original || publishing) return;
    if (unsaved) {
      warningTap();
      Alert.alert(
        "Save your changes first",
        "Save your changes before making this live.",
      );
      return;
    }
    setPublishing(true);
    try {
      const res = await coachPackagesApi.publish(original.id);
      setOriginal(res.data);
      if (isLivePackage(res.data)) {
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
      const f = describeError(err, "make your package live");
      Alert.alert(f.title, f.body);
    } finally {
      setPublishing(false);
    }
  }, [original, publishing, unsaved]);

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
                errorMessage(err, "Please try again."),
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
    const features = featuresText
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    // B-347-2: only a trial the server returned on the saved package; this
    // build never sends trial_days, so a typed trial is never previewed.
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
      features,
      coach: { displayName: coachDisplayName, bio: null },
    };
  }, [
    priceText,
    featuresText,
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
              This package is archived. Restore it by setting status back to
              Active in the form below — current subscribers are unaffected.
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

        <Label semanticColors={semanticColors} tokens={tokens}>
          Billing
        </Label>
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

        {/* B-347-2: no trial input until trial_days reaches the server
            (backend trials + m#338 bring it back together). */}

        <Label semanticColors={semanticColors} tokens={tokens}>
          Features (one per line)
        </Label>
        <TextInput
          value={featuresText}
          onChangeText={setFeaturesText}
          placeholder={"Weekly check-ins\nCustom workout plan\nMeal plan"}
          style={[styles.input, styles.inputMultiline, { minHeight: 120 }]}
          placeholderTextColor={semanticColors.textMuted}
          multiline
        />

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
                  onPress={() => void handlePublish()}
                  disabled={publishing}
                  accessibilityRole="button"
                  accessibilityLabel={`Make ${original.title} live`}
                  accessibilityState={{ busy: publishing, disabled: publishing }}
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
                    Save your changes before making this live.
                  </Text>
                ) : null}
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
  });
