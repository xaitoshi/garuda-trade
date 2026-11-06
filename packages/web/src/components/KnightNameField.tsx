import { KNIGHT_NAME_MAX, randomKnightName } from "../lib/knight";

/** Shared name + Roll control for demo create and one-shot rename. */
export function KnightNameField({
  value,
  onChange,
  disabled,
  label = "Name your knight",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="nm-field">
      <span className="lbl">{label}</span>
      <span className="nm-row">
        <input
          value={value}
          maxLength={KNIGHT_NAME_MAX}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          data-testid="knight-name"
          aria-label={label}
          placeholder="Sir Pudding"
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(randomKnightName())} disabled={disabled} aria-label="Random name">
          Roll
        </button>
      </span>
    </label>
  );
}
