export interface CalendarDropTarget {
  date: Date;
  allDay: boolean;
  rect: { left: number; top: number; width: number; height: number };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Native Logseq bullet drags carry these types across the plugin iframe.
// Read types during dragover; browsers expose their contents only on drop.
export function isLogseqBlockDrag(data: Pick<DataTransfer, "types">): boolean {
  return data.types.includes("block-uuid") || data.types.includes("block-dom-id");
}

export function readDroppedBlockUuid(data: Pick<DataTransfer, "getData">): string | null {
  const uuid = data.getData("block-uuid").trim();
  if (uuidPattern.test(uuid)) return uuid;
  const domId = data.getData("block-dom-id").trim();
  const match = domId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match && domId.startsWith("ls-block-") ? match[1] : null;
}

/** Use rendered slot geometry, including scrolling, without FullCalendar's private APIs. */
export function calendarDropTarget(container: HTMLElement, x: number, y: number): CalendarDropTarget | null {
  const hit = container.ownerDocument.elementFromPoint(x, y);
  if (!hit || !container.contains(hit)) return null;

  const day = hit.closest<HTMLElement>(".fc-daygrid-day[data-date]");
  if (day && container.contains(day)) {
    const date = day.dataset.date;
    if (!date) return null;
    return { date: new Date(`${date}T00:00:00`), allDay: true, rect: day.getBoundingClientRect() };
  }

  if (!hit.closest(".fc-timegrid-body")) return null;
  const col = Array.from(container.querySelectorAll<HTMLElement>(".fc-timegrid-col[data-date]"))
    .find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
  const slot = Array.from(container.querySelectorAll<HTMLElement>(".fc-timegrid-slot-lane[data-time]"))
    .find((el) => {
      const r = el.getBoundingClientRect();
      return y >= r.top && y < r.bottom;
    });
  if (!col?.dataset.date || !slot?.dataset.time) return null;
  const date = new Date(`${col.dataset.date}T${slot.dataset.time}`);
  if (!Number.isFinite(date.getTime())) return null;
  const c = col.getBoundingClientRect();
  const s = slot.getBoundingClientRect();
  return { date, allDay: false, rect: { left: c.left, top: s.top, width: c.width, height: s.height } };
}
