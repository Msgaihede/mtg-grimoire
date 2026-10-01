export function LightApp({ gate }: { gate: boolean }) {
  return (
    <p className="p-6 text-sm text-dim">
      The light app{gate ? "" : " (fake backend)"}.
    </p>
  );
}
