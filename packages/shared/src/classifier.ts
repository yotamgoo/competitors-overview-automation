import type { NormalizedAd } from "./types.js";

export const VERTICAL_RULES: Record<string, readonly string[]> = {
  pet_insurance: [
    "pet insurance",
    "dog insurance",
    "cat insurance",
    "vet bills",
    "vet bill",
    "veterinary care",
    "pet wellness",
    "accident and illness coverage",
    "accident & illness coverage"
  ],
  auto_insurance: [
    "auto insurance",
    "car insurance",
    "vehicle insurance",
    "sr-22",
    "safe driver",
    "good driver",
    "drivewise",
    "accident forgiveness",
    "liability coverage",
    "collision coverage",
    "comprehensive coverage",
    "/auto",
    "/car-insurance",
    "/vehicle-insurance"
  ],
  home_insurance: [
    "home insurance",
    "homeowners insurance",
    "house insurance",
    "dwelling coverage",
    "property insurance",
    "home policy",
    "/home-insurance",
    "/homeowners"
  ],
  renters_insurance: [
    "renters insurance",
    "renter's insurance",
    "tenant insurance",
    "apartment insurance",
    "/renters-insurance"
  ],
  life_insurance: [
    "life insurance",
    "term life",
    "whole life",
    "final expense",
    "burial insurance",
    "beneficiary",
    "death benefit",
    "/life-insurance"
  ],
  health_insurance: [
    "health insurance",
    "health plan",
    "medical insurance",
    "medical coverage",
    "marketplace plan",
    "aca plan",
    "obamacare",
    "medicare",
    "medicaid",
    "/health-insurance"
  ],
  dental_insurance: [
    "dental insurance",
    "dental plan",
    "orthodontic coverage",
    "/dental-insurance"
  ],
  travel_insurance: [
    "travel insurance",
    "trip protection",
    "trip cancellation",
    "travel medical",
    "/travel-insurance"
  ],
  disability_insurance: [
    "disability insurance",
    "income protection",
    "short term disability",
    "long term disability",
    "/disability-insurance"
  ]
};

export function normalizeClassifierText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9/]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function classifyAd(ad: Pick<NormalizedAd, "brand" | "title" | "adCopy" | "landingPageUrl" | "cta">): string | null {
  const haystack = normalizeClassifierText(
    [ad.brand, ad.title, ad.adCopy, ad.landingPageUrl ?? "", ad.cta].join(" ")
  );

  if (!haystack) {
    return null;
  }

  let bestVertical: string | null = null;
  let bestScore = 0;

  for (const [vertical, keywords] of Object.entries(VERTICAL_RULES)) {
    let score = 0;
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) {
        score += Math.max(keyword.split(" ").length, 1);
      }
    }
    if (score > bestScore) {
      bestVertical = vertical;
      bestScore = score;
    }
  }

  return bestVertical;
}
