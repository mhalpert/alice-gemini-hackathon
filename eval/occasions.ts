// Evaluation occasion set for the Outfits track: 20 test-kit briefs, 2 demo briefs,
// and 5 team-written messy briefs (source: 'messy').
import type { Gender } from '../src/types.ts';

export type EvalSource = 'test-kit' | 'messy';

export interface EvalOccasion {
  id: string;
  gender: Gender;
  occasion: string;
  budget_usd: number;
  source: EvalSource;
}

export const EVAL_OCCASIONS: EvalOccasion[] = [
  // Test kit (20 briefs: 10 occasions x men & women)
  { id: 'first-date-men', gender: 'men', occasion: 'first date at a cocktail bar', budget_usd: 150, source: 'test-kit' },
  { id: 'first-date-women', gender: 'women', occasion: 'first date at a cocktail bar', budget_usd: 150, source: 'test-kit' },

  { id: 'wedding-men', gender: 'men', occasion: 'outdoor summer wedding guest', budget_usd: 200, source: 'test-kit' },
  { id: 'wedding-women', gender: 'women', occasion: 'outdoor summer wedding guest', budget_usd: 150, source: 'test-kit' },

  { id: 'interview-men', gender: 'men', occasion: 'job interview at a creative agency', budget_usd: 180, source: 'test-kit' },
  { id: 'interview-women', gender: 'women', occasion: 'job interview at a bank', budget_usd: 180, source: 'test-kit' },

  { id: 'brunch-men', gender: 'men', occasion: 'Sunday brunch', budget_usd: 120, source: 'test-kit' },
  { id: 'brunch-women', gender: 'women', occasion: 'Sunday brunch', budget_usd: 120, source: 'test-kit' },

  { id: 'festival-men', gender: 'men', occasion: 'desert music festival', budget_usd: 120, source: 'test-kit' },
  { id: 'festival-women', gender: 'women', occasion: 'desert music festival', budget_usd: 120, source: 'test-kit' },

  { id: 'club-men', gender: 'men', occasion: 'night out at a club', budget_usd: 150, source: 'test-kit' },
  { id: 'club-women', gender: 'women', occasion: 'night out at a club', budget_usd: 120, source: 'test-kit' },

  { id: 'beach-men', gender: 'men', occasion: 'beach vacation in Miami', budget_usd: 150, source: 'test-kit' },
  { id: 'beach-women', gender: 'women', occasion: 'beach vacation in Miami', budget_usd: 150, source: 'test-kit' },

  { id: 'business-casual-men', gender: 'men', occasion: 'business casual first week', budget_usd: 200, source: 'test-kit' },
  { id: 'business-casual-women', gender: 'women', occasion: 'business casual first week', budget_usd: 200, source: 'test-kit' },

  { id: 'gala-men', gender: 'men', occasion: 'black tie optional gala', budget_usd: 250, source: 'test-kit' },
  { id: 'gala-women', gender: 'women', occasion: 'black tie optional gala', budget_usd: 250, source: 'test-kit' },

  { id: 'tailgate-men', gender: 'men', occasion: 'fall tailgate', budget_usd: 130, source: 'test-kit' },
  { id: 'apple-picking-women', gender: 'women', occasion: 'apple picking', budget_usd: 130, source: 'test-kit' },

  // Demo occasion (both departments)
  { id: 'rooftop-men', gender: 'men', occasion: "a friend's rooftop birthday", budget_usd: 150, source: 'test-kit' },
  { id: 'rooftop-women', gender: 'women', occasion: "a friend's rooftop birthday", budget_usd: 150, source: 'test-kit' },

  // Team-written messy briefs (keep ids hacker-1..hacker-5)
  {
    id: 'hacker-1',
    gender: 'men',
    occasion: "my girlfriend's parents are taking us to a fancy-ish Italian place, don't want to look like I'm trying too hard",
    budget_usd: 200,
    source: 'messy',
  },
  {
    id: 'hacker-2',
    gender: 'women',
    occasion: 'work holiday party at a rooftop bar in December, coming straight from the office',
    budget_usd: 250,
    source: 'messy',
  },
  {
    id: 'hacker-3',
    gender: 'men',
    occasion: 'second date, bowling then probably drinks after',
    budget_usd: 120,
    source: 'messy',
  },
  {
    id: 'hacker-4',
    gender: 'women',
    occasion: "my cousin's quinceañera, church in the afternoon then a party hall at night",
    budget_usd: 180,
    source: 'messy',
  },
  {
    id: 'hacker-5',
    gender: 'women',
    occasion: 'first day teaching middle school, on my feet all day',
    budget_usd: 100,
    source: 'messy',
  },
];
