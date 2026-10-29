"use client";

import { Check, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Voice } from "@/lib/types";
import { cn } from "./cn";

interface VoicePickerProps {
  voices: Voice[];
  selectedId: string;
  error?: string;
  onSelect: (id: string) => void;
}

export function VoicePicker({ voices, selectedId, error, onSelect }: VoicePickerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [missingSampleId, setMissingSampleId] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  function togglePreview(voice: Voice) {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === voice.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    if (!voice.sampleUrl) {
      audio.pause();
      setPlayingId(null);
      setMissingSampleId(voice.id);
      return;
    }
    setMissingSampleId(null);
    audio.src = voice.sampleUrl;
    audio
      .play()
      .then(() => setPlayingId(voice.id))
      .catch(() => {
        setPlayingId(null);
        setMissingSampleId(voice.id);
      });
  }

  return (
    <fieldset>
      <legend className="sr-only">בחירת קול</legend>
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} preload="none" />
      <ul className="flex flex-col gap-2">
        {voices.map((voice) => {
          const selected = voice.id === selectedId;
          const playing = playingId === voice.id;
          return (
            <li key={voice.id}>
              <div
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-call",
                  selected ? "border-call bg-call-soft" : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <button
                  type="button"
                  onClick={() => togglePreview(voice)}
                  aria-label={playing ? `עצירת הדוגמה של ${voice.name}` : `השמעת דוגמה של ${voice.name}`}
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-full border transition-colors",
                    playing
                      ? "border-call bg-call text-white"
                      : "border-line-strong bg-surface text-call hover:border-call",
                  )}
                >
                  {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
                </button>

                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="voice"
                    value={voice.id}
                    checked={selected}
                    onChange={() => onSelect(voice.id)}
                    className="sr-only"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={cn("font-medium", selected && "text-call-strong")}>{voice.name}</span>
                      {voice.tier === "premium" && (
                        <span className="rounded-full border border-line-strong px-2 text-xs leading-5 text-ink-soft">
                          פרימיום
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-sm text-ink-soft">
                      {voice.gender === "female" ? "קול נשי" : "קול גברי"}, {voice.description}
                    </span>
                  </span>
                  <Check
                    aria-hidden
                    className={cn("size-5 shrink-0 text-call", selected ? "opacity-100" : "opacity-0")}
                  />
                </label>
              </div>
              {missingSampleId === voice.id && (
                <p className="px-3 pt-1.5 text-sm text-ink-soft" role="status">
                  עדיין אין דוגמת שמע לקול הזה. אפשר לשמוע אותו בשיחת ניסיון.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </fieldset>
  );
}
