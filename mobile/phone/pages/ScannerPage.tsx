import { Camera } from "lucide-react";

/** A sentence where the scanner will be. It opens no camera and asks for no permission. */
export function ScannerPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Camera aria-hidden className="size-8 text-dim" />
      <p className="max-w-prose text-sm text-dim">
        The scanner arrives in a later phase. It will point this device's camera at a card and name
        the printing.
      </p>
    </div>
  );
}
