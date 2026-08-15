import { formatDateForJournal } from "../components/calendarUtils";

export interface JournalPage {
  uuid: string;
  name?: string;
}

/** Gets or creates the journal page for a date, using the user's preferred date format. */
export const getOrCreateJournalPage = async (date: Date): Promise<JournalPage | null> => {
  const normalizedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const userConfigs = await logseq.App.getUserConfigs();
  const preferredDateFormat = userConfigs?.preferredDateFormat || "yyyy-MM-dd EEE";
  const journalName = formatDateForJournal(normalizedDate, preferredDateFormat);

  let page = await logseq.Editor.getPage(journalName);
  if (!page) {
    page = await logseq.Editor.createPage(journalName, {}, { journal: true });
  }
  return page ? { uuid: page.uuid, name: page.name } : null;
};
