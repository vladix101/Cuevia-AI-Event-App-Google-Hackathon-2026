// SYNTHETIC DEVELOPMENT FIXTURES — not real events, people, transcripts or model output.
// Shapes match public HTTP contract v1 exactly. Loaded only when VITE_USE_MOCKS=true.

export const SYNTHETIC_TAG = '[SINTETIČKI]'

export const fixtureEvents = [
  { id: 'dev-event-1', title: `${SYNTHETIC_TAG} Demo konferencija 2026` },
  { id: 'dev-event-2', title: `${SYNTHETIC_TAG} Drugi demo događaj` },
]

export const fixtureTalks: Record<string, { id: string; title: string; speaker_name: string; status: 'scheduled' | 'live' | 'ended' }[]> = {
  'dev-event-1': [
    { id: 'dev-talk-1', title: `${SYNTHETIC_TAG} Uvod u vektorske baze`, speaker_name: 'Demo Govornik A', status: 'live' },
    { id: 'dev-talk-2', title: `${SYNTHETIC_TAG} Observability u produkciji`, speaker_name: 'Demo Govornik B', status: 'scheduled' },
    { id: 'dev-talk-3', title: `${SYNTHETIC_TAG} Završeno predavanje`, speaker_name: 'Demo Govornik C', status: 'ended' },
  ],
  'dev-event-2': [],
}

/** Placeholder sentences returned as "transcript" for each accepted audio chunk. NOT transcription. */
export const syntheticSentences = [
  'Ovo je sintetički segment, nije prepoznat govor.',
  'Indeks HNSW omogućava približnu pretragu najbližih suseda.',
  'Embedding je vektorska reprezentacija teksta.',
  'Kosinusna sličnost meri ugao između dva vektora.',
  'Kvantizacija smanjuje memoriju po ceni preciznosti.',
  'Reranking poboljšava redosled kandidata nakon pretrage.',
]

export const fixtureOpportunities = [
  { id: 'dev-opp-1', recipient_id: 'dev-sponsor-1', recipient_kind: 'sponsor' as const, title: `${SYNTHETIC_TAG} ML inženjer praksa`, topics: ['vektorske baze', 'pretraga'] },
  { id: 'dev-opp-2', recipient_id: 'dev-group-1', recipient_kind: 'group' as const, title: `${SYNTHETIC_TAG} Meetup grupa za podatke`, topics: ['observability'] },
]
