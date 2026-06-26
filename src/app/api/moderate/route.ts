import { NextRequest, NextResponse } from 'next/server';
import { ModerateRequest, ModerateResponse } from '@/lib/types';

/**
 * POST /api/moderate
 *
 * Accepts a message text and calls the Perspective API to analyze toxicity.
 * Returns approved/rejected based on whether any toxicity score exceeds 0.7.
 * Fails open (allows the message) if the Perspective API is unavailable.
 */
export async function POST(request: NextRequest): Promise<NextResponse<ModerateResponse>> {
  try {
    // Parse request body
    let body: ModerateRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { approved: false, reason: 'Invalid request body.' },
        { status: 400 }
      );
    }

    // Validate input: reject empty text
    if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
      return NextResponse.json(
        { approved: false, reason: 'Message text is required.' },
        { status: 400 }
      );
    }

    const apiKey = process.env.PERSPECTIVE_API_KEY;
    if (!apiKey) {
      // Fail open: allow the message but log the configuration issue
      console.error('[Moderation] PERSPECTIVE_API_KEY is not configured. Failing open.');
      return NextResponse.json({ approved: true });
    }

    // Call Perspective API
    const perspectiveUrl = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${apiKey}`;

    const perspectiveBody = {
      comment: { text: body.text },
      requestedAttributes: {
        TOXICITY: {},
        SEVERE_TOXICITY: {},
        IDENTITY_ATTACK: {},
        INSULT: {},
        THREAT: {},
        SEXUALLY_EXPLICIT: {},
      },
      languages: ['en'],
    };

    let perspectiveResponse: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      perspectiveResponse = await fetch(perspectiveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(perspectiveBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (error: unknown) {
      // Fail open: Perspective API is unavailable
      console.error('[Moderation] Perspective API request failed. Failing open.', error);
      return NextResponse.json({ approved: true });
    }

    if (!perspectiveResponse.ok) {
      // Fail open: Perspective API returned an error
      console.error(
        `[Moderation] Perspective API returned status ${perspectiveResponse.status}. Failing open.`
      );
      return NextResponse.json({ approved: true });
    }

    // Parse the Perspective API response
    let data: PerspectiveApiResponse;
    try {
      data = await perspectiveResponse.json();
    } catch {
      console.error('[Moderation] Failed to parse Perspective API response. Failing open.');
      return NextResponse.json({ approved: true });
    }

    // Check each attribute score against the 0.7 threshold
    const threshold = 0.7;
    const attributeScores = data.attributeScores;

    if (!attributeScores) {
      console.error('[Moderation] No attribute scores in Perspective API response. Failing open.');
      return NextResponse.json({ approved: true });
    }

    for (const [attribute, scoreData] of Object.entries(attributeScores)) {
      const score = scoreData?.summaryScore?.value;
      if (typeof score === 'number' && score > threshold) {
        return NextResponse.json({
          approved: false,
          reason: `Message rejected: detected ${attribute.toLowerCase().replace('_', ' ')} content.`,
        });
      }
    }

    // All scores below threshold — approve the message
    return NextResponse.json({ approved: true });
  } catch (error: unknown) {
    // Fail open on any unexpected error
    console.error('[Moderation] Unexpected error in moderation route. Failing open.', error);
    return NextResponse.json({ approved: true });
  }
}

// ─── Perspective API Response Types ────────────────────────────────────────────

interface PerspectiveAttributeScore {
  summaryScore: {
    value: number;
    type: string;
  };
  spanScores?: Array<{
    begin: number;
    end: number;
    score: { value: number; type: string };
  }>;
}

interface PerspectiveApiResponse {
  attributeScores?: Record<string, PerspectiveAttributeScore>;
  languages?: string[];
  detectedLanguages?: string[];
}
