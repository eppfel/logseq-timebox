import { useState, useRef, useEffect, useCallback } from "react";
import { getGraphAdapter } from "../../adapters";

interface UseInlineEditReturn {
  editingEventId: string | null;
  editingText: string;
  editInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  hoveredEventId: string | null;
  setHoveredEventId: (id: string | null) => void;
  setEditingText: (text: string) => void;
  enterEditMode: (blockUuid: string) => Promise<void>;
  handleSaveEdit: () => Promise<void>;
  cancelEdit: () => void;
}

export function useInlineEdit(onSaveComplete: () => void): UseInlineEditReturn {
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);

  // Auto-focus and move cursor to end when entering edit mode
  useEffect(() => {
    if (!editingEventId) return;
    requestAnimationFrame(() => {
      const el = editInputRef.current;
      if (!el) return;
      const len = el.value.length;
      el.focus();
      el.setSelectionRange(len, len);
    });
  }, [editingEventId]);

  // Enter edit mode for a block
  const enterEditMode = useCallback(async (blockUuid: string) => {
    try {
      const adapter = await getGraphAdapter();
      const title = await adapter.getEditableTitle(blockUuid);
      if (title !== null) {
        setEditingEventId(blockUuid);
        setEditingText(title);
        // Focus input after render
        setTimeout(() => editInputRef.current?.focus(), 50);
      }
    } catch {
    }
  }, []);

  // Save inline edit
  const handleSaveEdit = useCallback(async () => {
    if (!editingEventId || !editingText.trim()) {
      setEditingEventId(null);
      setEditingText("");
      return;
    }

    try {
      const adapter = await getGraphAdapter();
      await adapter.saveTitle(editingEventId, editingText);
      logseq.UI.showMsg("Event updated", "success");
      onSaveComplete();
    } catch (error) {
      logseq.UI.showMsg(`Error updating event: ${error}`, "error");
    } finally {
      setEditingEventId(null);
      setEditingText("");
    }
  }, [editingEventId, editingText, onSaveComplete]);

  // Cancel editing without saving
  const cancelEdit = useCallback(() => {
    setEditingEventId(null);
    setEditingText("");
  }, []);

  return {
    editingEventId,
    editingText,
    editInputRef,
    hoveredEventId,
    setHoveredEventId,
    setEditingText,
    enterEditMode,
    handleSaveEdit,
    cancelEdit,
  };
}
