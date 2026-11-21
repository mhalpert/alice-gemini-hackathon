// Popular occasions pre-built into src/library/sets.json.
// Wordings are embedded alongside the main occasion so natural phrasing matches cleanly.
import type { Gender } from '../types.ts';

export interface LibraryOccasion {
  key: string;
  occasion: string;
  budget: Record<Gender, number>;
  wordings: string[];
  genders?: Gender[];
}

export const DEMO_OCCASION_KEY = 'rooftop-birthday';

export const OCCASIONS: LibraryOccasion[] = [
  {
    key: 'rooftop-birthday',
    occasion: "a friend's rooftop birthday party",
    budget: { men: 150, women: 150 },
    wordings: [
      "friend's rooftop birthday Saturday",
      "my buddy's birthday on a roof",
      'rooftop bday party',
      'birthday drinks on a rooftop bar',
      "friend's birthday party on a terrace",
      "rooftop party for my friend's birthday",
      'birthday on a rooftop in the city',
      'going to a rooftop birthday',
      'rooftop birthday drinks tonight',
      'outdoor rooftop birthday celebration',
    ],
  },
  {
    key: 'first-date',
    occasion: 'first date at a cocktail bar',
    budget: { men: 150, women: 150 },
    wordings: [
      'first date drinks at a nice bar',
      'cocktail bar date night',
      'meeting someone for cocktails on a first date',
      'drinks date at a dimly lit cocktail lounge',
      'first date tonight at a speakeasy',
    ],
  },
  {
    key: 'summer-wedding',
    occasion: 'outdoor summer wedding guest',
    budget: { men: 200, women: 150 },
    wordings: [
      'guest at an outdoor summer wedding',
      'garden wedding in July',
      "attending a friend's summer wedding outside",
      'warm weather outdoor wedding guest',
      'vineyard wedding in the summer',
    ],
  },
  {
    key: 'interview-creative',
    occasion: 'job interview at a creative agency',
    budget: { men: 180, women: 180 },
    wordings: [
      'interview at an ad agency or design studio',
      'creative job interview, smart not stuffy',
      'startup or media company interview',
      'interviewing at a marketing or design agency',
      'creative office interview outfit',
    ],
  },
  {
    key: 'interview-bank',
    occasion: 'job interview at a bank',
    budget: { men: 180, women: 180 },
    wordings: [
      'finance job interview',
      'interview at an investment bank or law firm',
      'corporate job interview at a formal office',
      'consulting or banking interview',
      'traditional business formal interview',
    ],
  },
  {
    key: 'brunch',
    occasion: 'Sunday brunch with friends',
    budget: { men: 120, women: 120 },
    wordings: [
      'weekend brunch with my friends',
      'bottomless brunch on Sunday morning',
      'casual brunch at a cafe',
      'Saturday morning brunch out',
      'brunch on a patio with friends',
    ],
  },
  {
    key: 'festival',
    occasion: 'desert music festival',
    budget: { men: 120, women: 120 },
    wordings: [
      'Coachella!',
      'music festival in the desert',
      'outdoor summer music festival weekend',
      'going to Coachella with friends',
      'all-day outdoor concert and music festival',
    ],
  },
  {
    key: 'club',
    occasion: 'night out at a club',
    budget: { men: 150, women: 120 },
    wordings: [
      'going clubbing tonight',
      'nightclub and dancing with friends',
      'late night out at a dance club',
      'hitting the club this weekend',
      'going out to a club in the city',
    ],
  },
  {
    key: 'beach',
    occasion: 'beach vacation in Miami',
    budget: { men: 150, women: 150 },
    wordings: [
      'Miami beach trip',
      'tropical beach vacation outfit',
      'resort wear for a beach getaway',
      'going to Miami for a warm beach weekend',
      'dinner by the beach on vacation',
    ],
  },
  {
    key: 'business-casual',
    occasion: 'first week at a business casual office',
    budget: { men: 200, women: 200 },
    wordings: [
      'new job at a business casual office',
      'smart casual office wear for work',
      'starting a new office job next week',
      'everyday business casual work outfit',
      'going into the office, business casual dress code',
    ],
  },
  {
    key: 'gala',
    occasion: 'black tie optional gala',
    budget: { men: 600, women: 250 },
    wordings: [
      'charity gala dinner',
      'black tie optional evening event',
      'formal fundraising gala tonight',
      'dressy formal evening dinner party',
      'fancy evening gala or awards ceremony',
    ],
  },
  {
    key: 'fall-weekend',
    occasion: 'fall weekend apple picking or a tailgate',
    budget: { men: 130, women: 130 },
    wordings: [
      'apple picking in the fall',
      'autumn tailgate party',
      'chilly fall weekend outdoors',
      'going to an orchard or pumpkin patch',
      'football tailgate on a crisp fall afternoon',
    ],
  },
];
