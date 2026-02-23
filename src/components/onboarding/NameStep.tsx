"use client";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

export function NameStep({ value, onChange }: Props) {
  return (
    <div className="card">
      <h2>What should we call your bot?</h2>
      <p className="muted">You can change this later.</p>
      <input
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="My Assistant"
      />
    </div>
  );
}
