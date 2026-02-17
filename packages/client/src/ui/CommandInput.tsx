import React, { useRef, useEffect, useCallback } from 'react';
import { useGameStore } from '../state/GameStore';
import { getGameClient } from '../network/GameClient';
import { STARSColors, STARSFonts } from '../radar/rendering/STARSTheme';

const getInputStyle = (stripPanelOpen: boolean): React.CSSProperties => ({
  position: 'absolute',
  bottom: 0,
  left: 200,
  right: stripPanelOpen ? 500 : 220,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  background: STARSColors.panelBg,
  borderTop: `1px solid ${STARSColors.panelBorder}`,
  padding: '0 8px',
  transition: 'right 0.2s ease-in-out',
});

const fieldStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: STARSColors.inputText,
  textShadow: `0 0 3px ${STARSColors.glow}`,
  fontFamily: STARSFonts.family,
  fontSize: STARSFonts.commandInput,
  caretColor: STARSColors.inputText,
};

const promptStyle: React.CSSProperties = {
  color: STARSColors.inputText,
  textShadow: `0 0 5px ${STARSColors.glow}`,
  marginRight: 6,
  fontSize: 14,
  fontWeight: 'bold',
};

const errorStyle: React.CSSProperties = {
  color: STARSColors.errorText,
  textShadow: '0 0 4px rgba(255,68,68,0.5)',
  fontFamily: STARSFonts.family,
  fontSize: 11,
  marginRight: 8,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 300,
};

export const CommandInput: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const aircraft = useGameStore((s) => s.aircraft);
  const selectedAircraftId = useGameStore((s) => s.selectedAircraftId);
  const commandHistory = useGameStore((s) => s.commandHistory);
  const commandHistoryIndex = useGameStore((s) => s.commandHistoryIndex);
  const lastCommandError = useGameStore((s) => s.lastCommandError);
  const stripPanelCollapsed = useGameStore((s) => s.stripPanelCollapsed);

  // Auto-fill callsign when aircraft selected
  useEffect(() => {
    if (selectedAircraftId && inputRef.current) {
      const ac = aircraft.find((a) => a.id === selectedAircraftId);
      if (ac) {
        const currentValue = inputRef.current.value;
        // Only auto-fill if input is empty or starts with a different callsign
        if (!currentValue || !currentValue.toUpperCase().startsWith(ac.callsign.toUpperCase())) {
          inputRef.current.value = ac.callsign + ' ';
          inputRef.current.focus();
        }
      }
    }
  }, [selectedAircraftId, aircraft]);

  // Global keyboard shortcut to focus command input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target === document.body &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1
      ) {
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const input = inputRef.current;
      if (!input) return;

      if (e.key === 'Enter') {
        const text = input.value.trim();
        if (!text) return;

        // Send raw text to the server - the server's CommandParser handles
        // both natural language ("descend and maintain 5000") and shorthand ("dm 5000").
        // The server only uses rawText from the command, so we construct a minimal
        // ControllerCommand and let the server do all parsing and validation.
        const parts = text.split(/\s+/);
        const callsign = parts[0]?.toUpperCase() ?? '';
        getGameClient().sendCommand({
          callsign,
          commands: [],
          rawText: text,
          timestamp: Date.now(),
        });
        useGameStore.getState().addCommandToHistory(text);
        useGameStore.getState().setLastCommandError(null);
        input.value = '';
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newIndex =
          commandHistoryIndex === -1
            ? commandHistory.length - 1
            : Math.max(0, commandHistoryIndex - 1);
        if (commandHistory[newIndex]) {
          input.value = commandHistory[newIndex];
          useGameStore.getState().setCommandHistoryIndex(newIndex);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (commandHistoryIndex >= 0) {
          const newIndex = commandHistoryIndex + 1;
          if (newIndex >= commandHistory.length) {
            input.value = '';
            useGameStore.getState().setCommandHistoryIndex(-1);
          } else {
            input.value = commandHistory[newIndex];
            useGameStore.getState().setCommandHistoryIndex(newIndex);
          }
        }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        // Auto-complete callsign
        const text = input.value;
        const firstWord = text.split(/\s/)[0]?.toUpperCase();
        if (firstWord) {
          const match = aircraft.find((a) =>
            a.callsign.toUpperCase().startsWith(firstWord)
          );
          if (match) {
            input.value = match.callsign + text.substring(firstWord.length);
          }
        }
      } else if (e.key === 'Escape') {
        input.value = '';
        useGameStore.getState().setLastCommandError(null);
        useGameStore.getState().setSelectedAircraft(null);
      }
    },
    [aircraft, commandHistory, commandHistoryIndex]
  );

  return (
    <div style={getInputStyle(!stripPanelCollapsed)}>
      <span style={promptStyle}>{'>'}</span>
      {lastCommandError && <span style={errorStyle}>{lastCommandError}</span>}
      <input
        ref={inputRef}
        style={fieldStyle}
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="CALLSIGN COMMAND [ARGS]"
        onKeyDown={handleKeyDown}
      />
      <style>{`
        input::placeholder {
          color: #003300 !important;
          text-shadow: none !important;
        }
        input:focus {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>
    </div>
  );
};
