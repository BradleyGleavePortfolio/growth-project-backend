/**
 * S-COACH-MOB-2 — one charge, with how the price became the coach's net:
 * price - card processing - TGP 2% (- head coach share - refunds) = net
 * (GET /v1/coach/money/charges/:id; another coach's id is a 404 with
 * MONEY_CHARGE_NOT_FOUND and gets specific copy).
 */
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../../../theme/ThemeProvider";
import {
  coachMoneyApi,
  type ChargeState,
  type MoneyCharge,
} from "../../../api/coachMoneyApi";
import {
  breakdownRows,
  cadenceLabel,
  chargeIsProblem,
  chargeStateLabel,
  money,
  shortDate,
} from "../../../lib/money/moneyCopy";
import SetupNotice from "../../../components/coach/setup/SetupNotice";
import type {
  CoachTabParamList,
  SettingsStackParamList,
} from "../../../navigation/CoachNavigator";
import { makeStyles } from "./MoneyScreen";
import { useSection } from "./useSection";
import { SafeAreaView } from "react-native-safe-area-context";
import MoneyBack from "./MoneyBack";

type Props = NativeStackScreenProps<SettingsStackParamList, "CoachMoneyCharge">;

/**
 * B-332-8 (Opus): what happened for a charge that moved no money, or null
 * when money moved (paid, refunded, disputed) or is still moving (pending).
 */
export function noMoneyMovedCopy(state: ChargeState | null): string | null {
  switch (state) {
    case "failed":
      return "The card payment did not go through, so the client was not charged and nothing from this charge reaches your payouts. Needs attention on Money shows whether TGP tries the card again.";
    case "canceled":
      return "The client started checkout but did not finish it, so nothing was charged.";
    default:
      return null;
  }
}

/**
 * Opus B-349-1: the header is one payment. A plan's price carries its
 * cadence ("$100.00 monthly"), because the breakdown below is the plan's
 * totals so far (the backend sums every payment on the plan).
 */
export function chargeHeadline(c: MoneyCharge): string {
  const price = money(c.amountCents, c.currency);
  if (c.billingType !== "recurring") return price;
  const cadence = cadenceLabel(c);
  return cadence === "Recurring"
    ? `${price} each payment`
    : `${price} ${cadence.toLowerCase()}`;
}

export default function MoneyChargeScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const id = route.params.chargeId;
  const detail = useSection(
    () => coachMoneyApi.charge(id),
    "load this charge",
    [id],
  );
  const d = detail.data;

  if (!d) {
    return (
      <View ph-no-capture style={styles.centred} testID="money-charge-screen">
        {detail.error ? (
          <View style={styles.inner}>
            <SetupNotice
              error={detail.error}
              onRetry={() => void detail.reload()}
              testID="money-charge-error"
            />
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={styles.linkBtn}
              accessibilityRole="button"
              testID="money-charge-back"
            >
              <Text style={styles.link}>Back to Money</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ActivityIndicator
            color={colors.primary}
            accessibilityLabel="Loading this charge"
          />
        )}
      </View>
    );
  }

  const c = d.charge;
  const plan = c.billingType === "recurring";
  const rows = breakdownRows({
    priceCents: d.priceCents,
    processingCents: d.processingCents,
    platformFeeCents: d.platformFeeCents,
    headCoachSplitCents: d.headCoachSplitCents,
    refundedCents: d.refundedCents,
    netCents: d.netCents,
    processingPaidBy: d.processingPaidBy,
  }).map((r) =>
    // Opus B-349-1: on a plan the first row is every payment so far.
    plan && r.key === "price" ? { ...r, label: "Clients paid so far" } : r,
  );
  const tabNav =
    navigation.getParent<NativeStackNavigationProp<CoachTabParamList>>();
  // B-332-8 (Opus): a failed payment or an unfinished checkout moved no
  // money, so it never shows "Clients paid" or "check back once it clears".
  // Opus B-349-1: a failed renewal on a plan that has been paid before
  // keeps the earlier payments; only the latest payment failed.
  const latestFailed = plan && c.state === "failed" && d.settled;
  const noMoney = latestFailed ? null : noMoneyMovedCopy(c.state);
  // Sol B-349-1: pending means no payment has gone through yet (for example
  // a free trial that has not billed), so there is no paid-money equation.
  const pending = c.state === "pending";
  const scheduled = `Price, not paid yet: ${money(d.priceCents, c.currency)}`;

  return (
    <SafeAreaView ph-no-capture style={styles.page} edges={["top"]}>
      <ScrollView
        style={styles.page}
        contentContainerStyle={styles.inner}
        testID="money-charge-screen"
      >
        <MoneyBack />
        <Text style={styles.h1} accessibilityRole="header">
          {chargeHeadline(c)}
        </Text>
        <Text style={[styles.rowSub, chargeIsProblem(c) && styles.problem]}>
          {chargeStateLabel(c)}
        </Text>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>{c.client.name}</Text>
          <Text style={styles.rowSub} testID="money-charge-meta">
            {[c.packageName, cadenceLabel(c), shortDate(c.createdAt)]
              .filter(Boolean)
              .join(", ")}
          </Text>
        </View>
        {noMoney ? (
          <View style={styles.card} testID="money-charge-no-money">
            <Text style={styles.rowTitle}>No money moved</Text>
            <Text style={styles.body}>{noMoney}</Text>
          </View>
        ) : null}
        {latestFailed ? (
          <View style={styles.card} testID="money-charge-latest-failed">
            <Text style={styles.rowTitle}>Latest payment failed</Text>
            <Text style={styles.body}>
              The latest payment on this plan did not go through. Earlier
              payments are counted below. Needs attention on Money shows whether
              TGP tries the card again.
            </Text>
          </View>
        ) : null}
        {pending ? (
          <View style={styles.card} testID="money-charge-breakdown">
            <Text style={styles.body} testID="money-charge-unsettled">
              No payment has gone through for this yet, so nothing has reached
              your payouts. A free trial is billed when it ends. The fee
              breakdown appears here after the first payment.
            </Text>
            <View style={styles.bRow} accessible accessibilityLabel={scheduled}>
              <Text style={styles.bLabel}>Price, not paid yet</Text>
              <Text style={styles.bLabel}>
                {money(d.priceCents, c.currency)}
              </Text>
            </View>
          </View>
        ) : null}
        {noMoney || pending ? null : (
          <Text style={styles.h2} accessibilityRole="header">
            {plan ? "This plan so far" : "How this adds up to your net"}
          </Text>
        )}
        {noMoney || pending ? null : (
          <View style={styles.card} testID="money-charge-breakdown">
            {plan ? (
              <Text style={styles.body} testID="money-charge-plan-totals">
                Totals for every payment on this plan so far, not only the one
                above.
              </Text>
            ) : null}
            {!d.settled ? (
              <Text style={styles.body} testID="money-charge-fees-pending">
                Stripe has not posted the fees for this charge yet, so the
                amounts below are not final.
              </Text>
            ) : null}
            {rows.map((r) => (
              <View
                key={r.key}
                style={styles.bRow}
                accessible
                accessibilityLabel={`${r.label}: ${r.sign < 0 ? "minus " : ""}${money(
                  r.cents,
                  c.currency,
                )}`}
              >
                <Text style={r.sign === 0 ? styles.bTotal : styles.bLabel}>
                  {r.label}
                </Text>
                <Text style={r.sign === 0 ? styles.bTotal : styles.bLabel}>
                  {r.sign < 0 ? "-" : ""}
                  {money(r.cents, c.currency)}
                </Text>
                {r.note ? <Text style={styles.bNote}>{r.note}</Text> : null}
              </View>
            ))}
          </View>
        )}
        {c.client.id ? (
          <TouchableOpacity
            onPress={() =>
              tabNav?.navigate("ClientsStack", {
                screen: "ClientMessages",
                params: { clientId: c.client.id, clientName: c.client.name },
              })
            }
            style={styles.primary}
            accessibilityRole="button"
            accessibilityLabel={`Message ${c.client.name}`}
            testID="money-charge-message"
          >
            <Text style={styles.primaryText}>Message {c.client.name}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
