import assert from "node:assert/strict";
import { test } from "node:test";
import { isLogseqBlockDrag, readDroppedBlockUuid, calendarDropTarget } from "../src/App/components/logseqBlockDrop";
import { createMdAdapter } from "../src/App/adapters/mdAdapter";

const uuid = "12345678-1234-1234-1234-123456789abc";
const transfer = (values: Record<string, string>) => ({
  types: Object.keys(values), getData: (type: string) => values[type] ?? "",
});

test("accepts native block drags without treating text, pages or files as blocks", () => {
  assert.equal(isLogseqBlockDrag(transfer({ "block-uuid": "" })), true);
  assert.equal(readDroppedBlockUuid(transfer({ "block-uuid": uuid })), uuid);
  assert.equal(readDroppedBlockUuid(transfer({ "block-uuid": "123", "block-dom-id": `ls-block-${uuid}` })), uuid);
  for (const data of [{ "text/plain": uuid }, { "page-name": "Example" }, { Files: uuid }]) {
    assert.equal(isLogseqBlockDrag(transfer(data)), false);
    assert.equal(readDroppedBlockUuid(transfer(data)), null);
  }
  assert.equal(readDroppedBlockUuid(transfer({ "block-uuid": "malformed" })), null);
});

test("maps scrolled slots and day columns to local time, including midnight", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const columns = [0, 1].map((i) => ({ dataset: { date: `2026-09-${18 + i}` }, getBoundingClientRect: () => rect(100 + i * 100, -400, 100, 1440) }));
  const slots = [
    { dataset: { time: "00:00:00" }, getBoundingClientRect: () => rect(100, 50, 200, 30) },
    { dataset: { time: "10:30:00" }, getBoundingClientRect: () => rect(100, 200, 200, 30) },
  ];
  let insideGrid = true;
  const hit = { closest: (selector: string) => selector === ".fc-timegrid-body" && insideGrid ? {} : null };
  const container = {
    ownerDocument: { elementFromPoint: () => hit }, contains: () => true,
    querySelectorAll: (selector: string) => selector.includes("col") ? columns : slots,
  } as unknown as HTMLElement;
  const target = calendarDropTarget(container, 250, 210)!;
  assert.equal(target.date.getDate(), 19);
  assert.equal(target.date.getHours(), 10);
  assert.equal(target.date.getMinutes(), 30);
  assert.equal(target.allDay, false);
  assert.deepEqual(target.rect, { left: 200, top: 200, width: 100, height: 30 });
  assert.equal(calendarDropTarget(container, 150, 60)!.allDay, false);
  assert.equal(calendarDropTarget(container, 150, 60)!.date.getHours(), 0);
  assert.equal(calendarDropTarget(container, 50, 210), null);
  insideGrid = false;
  assert.equal(calendarDropTarget(container, 250, 210), null);
});

test("month and all-day cells assign a date without a time", () => {
  const day = { dataset: { date: "2026-09-18" }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const container = {
    ownerDocument: { elementFromPoint: () => ({ closest: () => day }) }, contains: () => true,
  } as unknown as HTMLElement;
  const target = calendarDropTarget(container, 20, 20)!;
  assert.equal(target.allDay, true);
  assert.equal(target.date.getDate(), 18);
  assert.equal(target.date.getHours(), 0);
});

test("schedules existing blocks in place, preserves content and repeaters, and reports failures", async () => {
  let content = "TODO Write report\nDEADLINE: <2026-09-20 Sun>\nproject:: [[Work]]\nNotes";
  const writes: string[] = [];
  let exists = true;
  let failWrite = false;
  Object.assign(globalThis, { logseq: { Editor: {
    getBlock: async () => exists ? { uuid, content } : null,
    updateBlock: async (id: string, next: string) => {
      assert.equal(id, uuid);
      if (failWrite) throw new Error("Write failed");
      writes.push(next);
      content = next;
    },
  } } });
  const adapter = createMdAdapter();
  const date = new Date(2026, 8, 18, 10, 30);
  const options = { durationMins: 60, preferExistingDuration: true };
  await adapter.reschedule(uuid, date, false, options);
  assert.equal(content, "TODO Write report [d:1h]\nSCHEDULED: <2026-09-18 Fri 10:30>\nDEADLINE: <2026-09-20 Sun>\nproject:: [[Work]]\nNotes");
  content = "DOING Report [d:30m]\nSCHEDULED: <2026-09-17 Thu 09:00 ++1w>\nNotes";
  await adapter.reschedule(uuid, date, false, options);
  assert.equal(content, "DOING Report [d:30m]\nSCHEDULED: <2026-09-18 Fri 10:30 ++1w>\nNotes");
  await adapter.reschedule(uuid, date, true, { ...options, durationMins: null });
  assert.equal(content, "DOING Report\nSCHEDULED: <2026-09-18 Fri ++1w>\nNotes");
  content = "Plain block\nDetails";
  await adapter.reschedule(uuid, new Date(2026, 8, 18), false, options);
  assert.match(content, /^Plain block \[d:1h\]\nSCHEDULED: <2026-09-18 Fri 00:00>\nDetails$/);
  exists = false;
  await assert.rejects(adapter.reschedule(uuid, date, false, options), /Block not found/);
  assert.equal(writes.length, 4);
  exists = true;
  failWrite = true;
  await assert.rejects(adapter.reschedule(uuid, date, false, options), /Write failed/);
});
