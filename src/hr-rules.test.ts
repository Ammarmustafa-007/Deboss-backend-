import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateCost, basePay, dispatchSalesCommission, earnsVariablePay, profitShare, tieredCommission, tierFor, workingDays } from "./hr-rules.js";

const dispatcher = [{ from: 1500, rate: 8 }, { from: 2500, rate: 10 }, { from: 3500, rate: 12 }];
const brokerageSales = [{ from: 2500, rate: 8 }, { from: 3500, rate: 10 }, { from: 4500, rate: 12 }];
const brokerageOps = [{ from: 4000, rate: 8 }, { from: 5000, rate: 10 }, { from: 7000, rate: 12 }];

test("the document's four worked examples", () => {
  assert.equal(tieredCommission(3000, dispatcher).commission, 150);
  assert.equal(tieredCommission(4000, brokerageSales).commission, 150);
  assert.equal(tieredCommission(6000, brokerageOps).commission, 200);
  assert.equal(dispatchSalesCommission(2400, 2, { min_active_sales: 2, rate: 5 }).commission, 120);
});

test("below target pays nothing, and the rate applies to the whole amount above the first target", () => {
  assert.equal(tieredCommission(1499, dispatcher).commission, 0);
  assert.equal(tieredCommission(1500, dispatcher).commission, 0);
  assert.equal(tieredCommission(2000, dispatcher).commission, 40);
  assert.equal(tieredCommission(4000, dispatcher).commission, 300);
  assert.equal(dispatchSalesCommission(2400, 1, { min_active_sales: 2, rate: 5 }).commission, 0);
});

test("a level boundary earns the higher rate, and the next level is reported", () => {
  assert.equal(tierFor(2500, dispatcher).rate, 10);
  assert.equal(tierFor(2000, dispatcher).next?.from, 2500);
  assert.equal(tierFor(4000, dispatcher).next, null);
});

test("working days are Monday to Friday", () => {
  assert.equal(workingDays("2026-10").length, 22);
  assert.equal(workingDays("2026-02").length, 20);
});

const pay = (overrides = {}) => basePay({ base: 110000, period: "2026-10", joinedOn: "2025-01-01", lastWorkingDay: null, leaveDays: [], absentDays: [], paidLeaves: 1, ...overrides });

test("one absence is the paid leave; further ones are deducted at base / working days", () => {
  assert.equal(pay().base_net, 110000);
  assert.equal(pay({ absentDays: ["2026-10-01"] }).base_net, 110000);
  const two = pay({ absentDays: ["2026-10-01", "2026-10-02"] });
  assert.equal(two.leave_deduction, 5000);
  assert.equal(two.base_net, 105000);
  assert.equal(two.days_worked, 20);
});

test("a manager approving an absence as leave clears its deduction", () => {
  assert.equal(pay({ absentDays: ["2026-10-01"], leaveDays: ["2026-10-02"] }).leave_deduction, 0);
});

test("part months pay base x days employed / working days, for joiners and leavers", () => {
  assert.equal(pay({ joinedOn: "2026-10-16" }).base_net, 55000);
  assert.equal(pay({ joinedOn: "2026-10-16" }).employed_days, 11);
  assert.equal(pay({ lastWorkingDay: "2026-10-15" }).base_net, 55000);
});

test("days off outside employment are ignored", () => {
  assert.equal(pay({ joinedOn: "2026-10-16", absentDays: ["2026-10-01", "2026-10-02"] }).leave_deduction, 0);
});

test("only a served notice keeps commission", () => {
  assert.equal(earnsVariablePay(null), true);
  assert.equal(earnsVariablePay("NOTICE_SERVED"), true);
  assert.equal(earnsVariablePay("NO_NOTICE"), false);
  assert.equal(earnsVariablePay("FIRED"), false);
});

test("the four cost types", () => {
  const headcount = new Map([["sales", 3], ["dispatch", 1], ["ops", 4]]);
  assert.equal(allocateCost({ amount: 800, cost_type: "COMPANY_SHARED", department_ids: [] }, headcount).get("sales"), 300);
  assert.equal(allocateCost({ amount: 800, cost_type: "ONE_DEPARTMENT", department_ids: ["dispatch"] }, headcount).get("dispatch"), 800);
  const two = allocateCost({ amount: 400, cost_type: "TWO_DEPARTMENTS", department_ids: ["sales", "dispatch"] }, headcount);
  assert.equal(two.get("sales"), 300);
  assert.equal(two.get("dispatch"), 100);
  assert.equal(two.has("ops"), false);
  assert.equal(allocateCost({ amount: 800, cost_type: "COMPANY_ONLY", department_ids: [] }, headcount).size, 0);
});

test("profit share is zero in a loss month", () => {
  assert.equal(profitShare(1000, 25), 250);
  assert.equal(profitShare(-1000, 25), 0);
});
