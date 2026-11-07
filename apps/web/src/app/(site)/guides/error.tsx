"use client";

import { ErrorState } from "@/components/States";

export default function GuidesError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="We couldn't load the guides"
      message="The guides are temporarily unavailable. Please try again. Experiences and booking are still available."
      onRetry={reset}
    />
  );
}
