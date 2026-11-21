import type { Gender } from '../types.ts';

export interface LibraryOccasion {
  key: string;                         // kebab-case, unique
  occasion: string;                    // how a stylist would write the brief, 3-10 words
  budget: { men: number; women: number }; // USD for one full outfit: realistic for the occasion and for stores priced $10-150 a piece
  wordings: string[];                  // 3-5 ways a real shopper would SAY it, casual speech, including slang and typos-free short forms
  genders?: Gender[];                  // omit when it applies to both; ['women'] or ['men'] when it only makes sense for one
}

export const EXTRA_OCCASIONS: LibraryOccasion[] = [
  // Everyday casual (12)
  {
    key: 'coffee-date',
    occasion: 'casual daytime coffee shop date',
    budget: { men: 115, women: 110 },
    wordings: [
      'grabbing coffee with a Hinge match',
      'lowkey coffee date',
      'cute fit for a morning coffee run',
      'meeting someone for iced coffee',
    ],
  },
  {
    key: 'farmers-market',
    occasion: 'sunny weekend stroll at a farmers market',
    budget: { men: 95, women: 100 },
    wordings: [
      'farmers market run this Saturday',
      'easy breezy market morning fit',
      'walking around the local farmers market',
      'cute outfit to grab produce and flowers',
    ],
  },
  {
    key: 'stylish-errands',
    occasion: 'elevated off-duty look for running errands',
    budget: { men: 90, women: 95 },
    wordings: [
      'errands fit that still looks put together',
      'model off duty grocery run',
      'running errands without looking sloppy',
      'chic athleisure for a busy Saturday',
    ],
  },
  {
    key: 'movie-night',
    occasion: 'cozy theater outfit for a movie night',
    budget: { men: 95, women: 90 },
    wordings: [
      'going to the movies tonight',
      'comfy cute movie theater fit',
      'AMC date night outfit',
      'cozy fit for a late screening',
    ],
  },
  {
    key: 'museum-day',
    occasion: 'artsy comfortable look for exploring a museum',
    budget: { men: 120, women: 125 },
    wordings: [
      'spending the afternoon at the Met',
      'cute artsy museum day outfit',
      'walking around an art museum all day',
      'museum strolling fit with comfy shoes',
    ],
  },
  {
    key: 'park-picnic',
    occasion: 'relaxed lawn outfit for an afternoon picnic',
    budget: { men: 100, women: 105 },
    wordings: [
      'picnic in the park with friends',
      'cute outfit for sitting on a picnic blanket',
      'chill park hangout with snacks',
      'sunny afternoon lawn picnic fit',
    ],
  },
  {
    key: 'dog-park-meetup',
    occasion: 'practical casual outfit for a dog park meetup',
    budget: { men: 85, women: 85 },
    wordings: [
      'taking my pup to the dog park',
      'dog park hangout that can get a little dirty',
      'cute casual fit to walk the dog',
      'morning dog run meetup',
    ],
  },
  {
    key: 'friends-game-night',
    occasion: 'laid-back hangout look for board game night',
    budget: { men: 90, women: 90 },
    wordings: [
      "game night at my buddy's apartment",
      "chill fit for hanging at a friend's place",
      'board games and pizza night',
      'comfy house hangout outfit',
    ],
  },
  {
    key: 'airport-travel-day',
    occasion: 'polished comfortable outfit for a long flight',
    budget: { men: 115, women: 110 },
    wordings: [
      'airport outfit for a six hour flight',
      'cute comfy plane travel fit',
      'flying out early tomorrow morning',
      'TSA friendly travel day look',
    ],
  },
  {
    key: 'weekend-road-trip',
    occasion: 'breathable layered outfit for a scenic road trip',
    budget: { men: 100, women: 95 },
    wordings: [
      'hitting the road for a long drive',
      'comfy road trip fit with pit stops',
      'driving up the coast this weekend',
      'cute outfit for hours in the car',
    ],
  },
  {
    key: 'trail-walk-to-cafe',
    occasion: 'sporty casual look from easy trail to cafe',
    budget: { men: 110, women: 105 },
    wordings: [
      'quick morning hike then grabbing food after',
      'trail walk to lunch fit',
      'outdoorsy cute outfit for an easy hike',
      'athleisure that works at a cafe after a walk',
    ],
  },
  {
    key: 'backyard-barbecue',
    occasion: 'breezy summer cookout look for a backyard barbecue',
    budget: { men: 105, women: 100 },
    wordings: [
      "backyard BBQ at my cousin's house",
      'chill grill out fit',
      'summer barbecue in the yard',
      'casual outdoor cookout with burgers',
    ],
  },

  // Dates and nights out (10)
  {
    key: 'upscale-dinner-date',
    occasion: 'polished evening look for an upscale restaurant dinner',
    budget: { men: 170, women: 165 },
    wordings: [
      'dinner date at a really nice restaurant',
      'dressy date night fit',
      'fancy Italian spot tonight',
      'need a fire outfit for dinner reservations',
    ],
  },
  {
    key: 'wine-bar-date',
    occasion: 'effortless chic outfit for a wine bar date',
    budget: { men: 145, women: 140 },
    wordings: [
      'second date at a cute wine bar',
      'natural wine bar vibes tonight',
      'flirty lowkey fit for wine and small plates',
      'grabbing a glass of wine with my crush',
    ],
  },
  {
    key: 'anniversary-dinner',
    occasion: 'romantic dressy ensemble for an anniversary celebration',
    budget: { men: 180, women: 175 },
    wordings: [
      'our anniversary dinner this Friday',
      'special romantic date night look',
      'celebrating two years together at a nice spot',
      'want to look extra good for our anniversary',
    ],
  },
  {
    key: 'jazz-lounge-evening',
    occasion: 'moody stylish attire for a live jazz lounge',
    budget: { men: 160, women: 155 },
    wordings: [
      'going to a jazz bar downtown',
      'live jazz lounge night out',
      'classy moody fit for jazz music',
      'old school jazz spot vibes',
    ],
  },
  {
    key: 'speakeasy-drinks',
    occasion: 'sleek after-dark look for a hidden speakeasy',
    budget: { men: 155, women: 150 },
    wordings: [
      'hidden speakeasy drinks tonight',
      'cool underground bar fit',
      'edgy dressy outfit for a speakeasy',
      'secret bar date night',
    ],
  },
  {
    key: 'karaoke-night',
    occasion: 'fun expressive outfit for a private karaoke night',
    budget: { men: 125, women: 130 },
    wordings: [
      'karaoke night with the crew',
      'singing my heart out in Koreatown tonight',
      'fun going out fit for karaoke',
      'playful night out look for karaoke',
    ],
  },
  {
    key: 'comedy-show-night',
    occasion: 'smart relaxed outfit for a standup comedy show',
    budget: { men: 130, women: 125 },
    wordings: [
      'going to a comedy show tonight',
      'standup comedy show date fit',
      'chill night out outfit for a comedy set',
      'casual cool fit for live comedy',
    ],
  },
  {
    key: 'arena-concert',
    occasion: 'bold comfortable outfit for a stadium arena concert',
    budget: { men: 135, women: 140 },
    wordings: [
      'going to an arena concert this weekend',
      'cute concert fit I can stand in all night',
      'big stadium show outfit',
      'seeing my favorite artist live at the arena',
    ],
  },
  {
    key: 'valentines-day-dinner',
    occasion: "flirty romantic look for Valentine's evening plans",
    budget: { men: 165, women: 175 },
    wordings: [
      "Valentine's Day dinner fit",
      'V-Day date night outfit',
      "romantic red or pink look for Valentine's",
      'dressing up for February 14th',
    ],
  },
  {
    key: 'meeting-partners-parents',
    occasion: "warm polished outfit for meeting your partner's parents",
    budget: { men: 150, women: 145 },
    wordings: [
      "meeting my partner's parents for the first time",
      'good impression fit for dinner with the parents',
      'respectful cute outfit to meet the family',
      'need to look put together to meet the folks',
    ],
  },

  // Work (11)
  {
    key: 'tech-startup-first-day',
    occasion: 'modern smart-casual look for starting at a tech startup',
    budget: { men: 165, women: 160 },
    wordings: [
      'first day at a tech startup',
      "smart casual fit that isn't too corporate",
      'new startup job onboarding outfit',
      'clean modern look for a tech office',
    ],
  },
  {
    key: 'client-presentation',
    occasion: 'sharp authoritative look for pitching a big client',
    budget: { men: 205, women: 195 },
    wordings: [
      'presenting to a major client tomorrow',
      'power outfit for a client meeting',
      'sharp boardroom presentation fit',
      'need to look super credible for a client deck',
    ],
  },
  {
    key: 'networking-mixer',
    occasion: 'approachable polished attire for an industry networking mixer',
    budget: { men: 170, women: 165 },
    wordings: [
      'industry networking event after work',
      'business mixer outfit that feels approachable',
      'mingling with founders and recruiters',
      'smart evening networking fit',
    ],
  },
  {
    key: 'conference-speaker',
    occasion: 'camera-ready tailored outfit for speaking on stage',
    budget: { men: 215, women: 210 },
    wordings: [
      'speaking on a panel at a conference',
      'stage outfit for a keynote talk',
      'what to wear as a conference speaker',
      'polished look that pops under stage lights',
    ],
  },
  {
    key: 'office-holiday-party',
    occasion: 'festive workplace-appropriate look for the office holiday party',
    budget: { men: 185, women: 180 },
    wordings: [
      'company Christmas party next week',
      "office holiday party fit that's still HR safe",
      'festive work party outfit',
      'year end work celebration look',
    ],
  },
  {
    key: 'company-team-offsite',
    occasion: 'versatile smart-casual outfit for a multi-day team offsite',
    budget: { men: 160, women: 155 },
    wordings: [
      'going to a company retreat this week',
      'team offsite fit from workshops to dinner',
      'work retreat casual polished outfit',
      'three day team offsite packing look',
    ],
  },
  {
    key: 'law-firm-interview',
    occasion: 'classic conservative tailoring for a law firm interview',
    budget: { men: 220, women: 215 },
    wordings: [
      'big law interview next Monday',
      'super formal interview fit for a law firm',
      'conservative suit look for legal interviews',
      'callback interview at a law office',
    ],
  },
  {
    key: 'executive-sales-pitch',
    occasion: 'confident tailored attire for closing an enterprise sale',
    budget: { men: 210, women: 200 },
    wordings: [
      'huge sales pitch with execs',
      'closing meeting power fit',
      'confident sharp outfit to pitch a deal',
      'dressed to close a big contract',
    ],
  },
  {
    key: 'video-job-interview',
    occasion: 'crisp camera-flattering top-half look for a video interview',
    budget: { men: 150, women: 150 },
    wordings: [
      'Zoom job interview tomorrow morning',
      'remote interview outfit where the top half matters',
      'what looks good on webcam for an interview',
      'virtual interview fit that reads sharp on screen',
    ],
  },
  {
    key: 'promotion-celebration-dinner',
    occasion: 'celebratory elevated outfit for a promotion dinner',
    budget: { men: 180, women: 185 },
    wordings: [
      'just got promoted and celebrating at dinner',
      'promotion celebration night fit',
      'boss vibes outfit for my promotion toast',
      'celebrating a big career win tonight',
    ],
  },
  {
    key: 'after-work-happy-hour',
    occasion: 'desk-to-drinks smart outfit for coworker happy hour',
    budget: { men: 155, women: 150 },
    wordings: [
      'happy hour with coworkers right after work',
      'desk to drinks outfit',
      'grabbing drinks with the office crew at five',
      'work outfit that transitions to a bar',
    ],
  },

  // Weddings and ceremonies (12)
  {
    key: 'beach-wedding-guest',
    occasion: 'airy dressy attire for a coastal destination wedding',
    budget: { men: 195, women: 185 },
    wordings: [
      'beach wedding guest outfit',
      'dressy linen fit for a wedding on the sand',
      'destination wedding by the ocean',
      'breezy wedding attire for humid coastal weather',
    ],
  },
  {
    key: 'winter-wedding-guest',
    occasion: 'rich cold-weather guest look for a winter wedding',
    budget: { men: 235, women: 225 },
    wordings: [
      'winter wedding guest outfit',
      'warm dressy fit for a December wedding',
      'velvet or jewel tone wedding look for winter',
      'cold weather wedding attire',
    ],
  },
  {
    key: 'cocktail-attire-wedding',
    occasion: 'refined semi-formal guest ensemble for a cocktail wedding',
    budget: { men: 225, women: 215 },
    wordings: [
      'invite says cocktail attire wedding',
      'semi formal wedding guest fit',
      'dressy cocktail look for a wedding reception',
      'sharp cocktail dress code wedding outfit',
    ],
  },
  {
    key: 'courthouse-wedding-guest',
    occasion: 'understated chic outfit for a city hall wedding',
    budget: { men: 170, women: 165 },
    wordings: [
      'courthouse wedding guest fit',
      'intimate city hall ceremony outfit',
      'chic daytime look for a civil wedding',
      'small courthouse wedding plus lunch after',
    ],
  },
  {
    key: 'wedding-rehearsal-dinner',
    occasion: 'polished dressy outfit for a wedding rehearsal dinner',
    budget: { men: 195, women: 190 },
    wordings: [
      'rehearsal dinner the night before the wedding',
      'dressy fit for welcome drinks and rehearsal',
      'wedding weekend rehearsal dinner look',
      'smart upscale outfit for the rehearsal toast',
    ],
  },
  {
    key: 'engagement-party',
    occasion: "festive upscale outfit for celebrating a couple's engagement",
    budget: { men: 180, women: 175 },
    wordings: [
      "friend's engagement party this Saturday",
      'cocktail casual fit for an engagement toast',
      'cute dressy outfit for an engagement celebration',
      'what to wear to an engagement party',
    ],
  },
  {
    key: 'bridal-shower-guest',
    occasion: 'soft feminine daytime dress look for a bridal shower',
    budget: { men: 160, women: 165 },
    wordings: [
      "bridal shower guest fit that isn't white",
      'pastel floral outfit for a bridal shower',
      'cute daytime dress for a bride-to-be shower',
      'sweet girly look for a bridal luncheon',
    ],
    genders: ['women'],
  },
  {
    key: 'bachelor-party-night',
    occasion: 'sharp high-energy nightlife outfit for a bachelor party',
    budget: { men: 185, women: 180 },
    wordings: [
      'bachelor party weekend night out',
      "boys trip fit for the groom's bachelor party",
      'sharp going out look for a Vegas bachelor weekend',
      'dressy party outfit with the groomsmen',
    ],
    genders: ['men'],
  },
  {
    key: 'bachelorette-weekend',
    occasion: 'statement party look for a lively bachelorette weekend',
    budget: { men: 170, women: 185 },
    wordings: [
      'bachelorette trip outfit with the girls',
      'fun party fit for a bach weekend',
      'bold going out look for a bachelorette',
      'matching vibe outfit for a bride squad weekend',
    ],
    genders: ['women'],
  },
  {
    key: 'baby-shower-guest',
    occasion: 'cheerful daytime smart-casual outfit for a baby shower',
    budget: { men: 150, women: 155 },
    wordings: [
      'cute daytime fit for a baby shower',
      "soft light colors for a friend's baby shower",
      'sweet polished outfit for a weekend baby shower',
      'casual dressy baby shower guest look',
    ],
  },
  {
    key: 'graduation-ceremony',
    occasion: 'photo-ready daytime outfit for a commencement graduation ceremony',
    budget: { men: 175, women: 165 },
    wordings: [
      'graduation ceremony outfit that looks good in photos',
      'what to wear under a grad gown or in the stands',
      'commencement day fit for campus',
      'proud family graduation day look',
    ],
  },
  {
    key: 'christening-or-baptism',
    occasion: 'modest refined daytime attire for a christening ceremony',
    budget: { men: 175, women: 170 },
    wordings: [
      "baby's christening this Sunday",
      'respectful light outfit for a baptism',
      'modest dressy fit for church baptism and lunch',
      'family christening guest look',
    ],
  },

  // Celebrations (9)
  {
    key: 'new-years-eve-party',
    occasion: "sparkling glamorous statement outfit for New Year's Eve",
    budget: { men: 195, women: 205 },
    wordings: [
      'NYE party fit with some sparkle',
      'ringing in the new year outfit',
      "glam New Year's Eve countdown look",
      'flashy dressy fit for December 31st',
    ],
  },
  {
    key: 'family-holiday-dinner',
    occasion: 'warm festive cozy-chic outfit for family holiday dinner',
    budget: { men: 145, women: 140 },
    wordings: [
      'Christmas Eve dinner with the whole family',
      'festive but comfy holiday dinner fit',
      'cozy dressy look for Hanukkah or Christmas dinner',
      'holiday family photos and dinner outfit',
    ],
  },
  {
    key: 'thanksgiving-with-in-laws',
    occasion: 'polished comfortable autumn look for Thanksgiving with in-laws',
    budget: { men: 140, women: 135 },
    wordings: [
      "Thanksgiving at my in-laws' house",
      'cute fall outfit with room to eat turkey',
      'put together cozy fit for Thanksgiving with the in-laws',
      'autumn sweater look for Thanksgiving dinner',
    ],
  },
  {
    key: 'halloween-party-look',
    occasion: 'moody costume-free edgy outfit for a Halloween party',
    budget: { men: 135, women: 145 },
    wordings: [
      'Halloween party fit without wearing an actual costume',
      'spooky chic dark outfit for Halloween',
      'all black edgy look for a Halloween hangout',
      'subtle Halloween vibes going out fit',
    ],
  },
  {
    key: 'steakhouse-birthday-dinner',
    occasion: 'sleek upscale evening look for a steakhouse birthday',
    budget: { men: 190, women: 185 },
    wordings: [
      'birthday dinner at a fancy steakhouse',
      'main character outfit for my birthday dinner',
      'classy dressy fit for a steakhouse celebration',
      'treating myself to a nice birthday meal',
    ],
  },
  {
    key: 'retirement-party',
    occasion: 'respectful smart celebratory outfit for a retirement toast',
    budget: { men: 165, women: 160 },
    wordings: [
      "boss's retirement party this Thursday",
      'smart dressy fit for a retirement dinner',
      "celebrating my dad's retirement party",
      'classy semi-dressy look for a retirement sendoff',
    ],
  },
  {
    key: 'housewarming-party',
    occasion: "effortless casual-chic outfit for a friend's housewarming",
    budget: { men: 120, women: 125 },
    wordings: [
      'housewarming party at a new apartment',
      'cute casual fit to bring wine to a housewarming',
      'relaxed stylish look for a home gathering',
      'weekend housewarming hangout outfit',
    ],
  },
  {
    key: 'friendsgiving-dinner',
    occasion: 'cozy autumn layered outfit for attending Friendsgiving',
    budget: { men: 125, women: 120 },
    wordings: [
      'Friendsgiving potluck with the squad',
      'cute cozy sweater fit for Friendsgiving',
      'chill fall dinner with friends',
      'comfortable autumn outfit for Friendsgiving',
    ],
  },
  {
    key: 'fourth-of-july-cookout',
    occasion: 'breezy Americana summer outfit for Fourth of July fireworks',
    budget: { men: 110, women: 110 },
    wordings: [
      'Fourth of July cookout and fireworks',
      'cute red white and blue summer fit',
      'July 4th patio hangout outfit',
      'patriotic casual look for Independence Day',
    ],
  },

  // Formal (6)
  {
    key: 'black-tie-wedding',
    occasion: 'full-length formal black-tie attire for an evening wedding',
    budget: { men: 295, women: 285 },
    wordings: [
      'strict black tie wedding invite',
      'tuxedo or floor length gown wedding look',
      'super formal evening wedding guest fit',
      'high glamour black tie wedding outfit',
    ],
  },
  {
    key: 'opera-or-ballet-night',
    occasion: 'dramatic cultured eveningwear for the opera or ballet',
    budget: { men: 260, women: 255 },
    wordings: [
      'going to the opera at Lincoln Center',
      'dressy night at the ballet',
      'classic formal fit for the symphony or opera',
      'old money evening look for a live performance',
    ],
  },
  {
    key: 'formal-charity-dinner',
    occasion: 'elegant eveningwear for a formal charity fundraising dinner',
    budget: { men: 270, women: 265 },
    wordings: [
      'charity benefit dinner next month',
      'formal fundraising dinner outfit',
      'upscale donor banquet dress code',
      'polished eveningwear for a nonprofit benefit',
    ],
  },
  {
    key: 'awards-ceremony',
    occasion: 'red-carpet inspired statement formalwear for an awards ceremony',
    budget: { men: 280, women: 290 },
    wordings: [
      'industry awards show night',
      'red carpet vibe formal outfit',
      'nominated at an awards ceremony tonight',
      'showstopping formal fit for an awards banquet',
    ],
  },
  {
    key: 'high-school-prom',
    occasion: 'glamorous unforgettable formalwear for prom night',
    budget: { men: 230, women: 245 },
    wordings: [
      'prom outfit that steals the show',
      'senior prom formal fit',
      'glam prom night dress or sharp suit',
      'getting ready for prom photos and dancing',
    ],
  },
  {
    key: 'homecoming-dance',
    occasion: 'youthful semi-formal party outfit for homecoming dance',
    budget: { men: 200, women: 205 },
    wordings: [
      'hoco dance outfit this fall',
      'cute semi-formal look for homecoming',
      'fun party fit for homecoming night',
      'short dress or sharp blazer for hoco',
    ],
  },

  // Travel and seasons (12)
  {
    key: 'european-summer-trip',
    occasion: 'breezy Mediterranean sightseeing outfit for European summer travel',
    budget: { men: 150, women: 155 },
    wordings: [
      'Euro summer vacation fit',
      'Amalfi Coast and Greece sightseeing outfit',
      'breezy linen travel look for Europe',
      'cute walkable outfits for Mediterranean summer',
    ],
  },
  {
    key: 'apres-ski-lodge',
    occasion: 'cozy alpine knitwear look for ski lodge apres-ski',
    budget: { men: 175, women: 180 },
    wordings: [
      'apres ski drinks by the fire',
      'Aspen chalet cozy chic outfit',
      'ski trip lodge look after the slopes',
      'alpine sweater and boots vibe',
    ],
  },
  {
    key: 'tropical-resort-dinner',
    occasion: 'breezy elevated islandwear for a tropical resort dinner',
    budget: { men: 165, women: 160 },
    wordings: [
      'sunset dinner at a Caribbean resort',
      'dressy tropical vacation dinner fit',
      'resort chic outfit for an oceanfront restaurant',
      'island getaway evening look',
    ],
  },
  {
    key: 'paris-city-break',
    occasion: 'effortlessly tailored chic ensemble for exploring Paris',
    budget: { men: 175, women: 175 },
    wordings: [
      'long weekend trip to Paris',
      'Parisian chic walking outfit',
      'cafe hopping in Le Marais fit',
      'classic understated look for a Paris city break',
    ],
  },
  {
    key: 'tokyo-street-trip',
    occasion: 'fashion-forward layered streetwear for exploring Tokyo neighborhoods',
    budget: { men: 160, women: 165 },
    wordings: [
      'Tokyo trip streetwear fit',
      'cool layered walking outfit for Shibuya and Harajuku',
      'fashionable comfy outfit for Japan travel',
      'minimalist edgy look for exploring Tokyo',
    ],
  },
  {
    key: 'cruise-evening-dinner',
    occasion: "dressy nautical-polished look for cruise ship captain's dinner",
    budget: { men: 175, women: 170 },
    wordings: [
      'cruise formal dinner night outfit',
      'dressing up for the ship dining room',
      'classy evening fit for a cruise',
      "captain's dinner look on vacation",
    ],
  },
  {
    key: 'lake-house-weekend',
    occasion: 'preppy relaxed layers for a weekend lake house',
    budget: { men: 130, women: 125 },
    wordings: [
      'lake house weekend with friends',
      'dockside hangout and bonfire fit',
      'relaxed preppy cabin by the lake outfit',
      'chill summer weekend at the lake',
    ],
  },
  {
    key: 'camping-weekend',
    occasion: 'rugged practical layered outfit for a wooded camping weekend',
    budget: { men: 115, women: 110 },
    wordings: [
      'camping trip in the woods',
      'practical cute fit for tents and campfires',
      'durable outdoor layers for weekend camping',
      'flannel and boots camping outfit',
    ],
  },
  {
    key: 'spring-garden-party',
    occasion: 'fresh botanical daytime attire for a spring garden party',
    budget: { men: 160, women: 165 },
    wordings: [
      'spring garden party invite',
      'floral pastel outdoor afternoon fit',
      'tea and champagne on the lawn outfit',
      'light romantic look for a backyard garden party',
    ],
  },
  {
    key: 'summer-pool-party',
    occasion: 'sun-ready vibrant coverup look for a daytime pool party',
    budget: { men: 115, women: 120 },
    wordings: [
      'pool party this Saturday afternoon',
      'cute poolside lounging fit',
      'cabana drinks and swim coverup outfit',
      'bright summer pool hangout look',
    ],
  },
  {
    key: 'rainy-city-day',
    occasion: 'sleek weatherproof layered outfit for a rainy city commute',
    budget: { men: 155, women: 150 },
    wordings: [
      'pouring rain in the city today',
      "cute rainy day outfit that won't get ruined",
      'trench coat and boots wet weather fit',
      'staying dry while still looking sharp downtown',
    ],
  },
  {
    key: 'winter-holiday-market',
    occasion: 'bundled-up festive outerwear look for an outdoor winter market',
    budget: { men: 165, women: 160 },
    wordings: [
      'walking around a Christmas market with hot cocoa',
      'cute bundled up winter market outfit',
      'cozy coat and scarf look for holiday stalls',
      'chilly evening stroll at a winter bazaar',
    ],
  },

  // Sports and outdoors spectator (6)
  {
    key: 'baseball-game',
    occasion: 'sun-friendly casual stadium outfit for a daytime baseball game',
    budget: { men: 105, women: 105 },
    wordings: [
      'going to a Yankees or Dodgers game',
      'cute ballpark outfit for sitting in the bleachers',
      'casual baseball stadium fit',
      'sunny day at the ballpark look',
    ],
  },
  {
    key: 'basketball-courtside',
    occasion: 'flashy elevated streetwear look for courtside basketball seats',
    budget: { men: 190, women: 195 },
    wordings: [
      'sitting courtside at an NBA game',
      'tunnel walk celebrity vibe basketball fit',
      'fly streetwear outfit for a pro hoops game',
      'flexing in floor seats tonight',
    ],
  },
  {
    key: 'client-golf-day',
    occasion: 'crisp country-club athletic attire for golfing with clients',
    budget: { men: 165, women: 160 },
    wordings: [
      'golfing eighteen holes with work clients',
      'country club dress code golf outfit',
      'preppy athletic fit for a business golf outing',
      'sharp polo and course-ready look',
    ],
  },
  {
    key: 'tennis-match-spectator',
    occasion: 'preppy crisp courtside attire for watching a tennis match',
    budget: { men: 155, women: 160 },
    wordings: [
      'going to the US Open tennis match',
      'tenniscore spectator outfit',
      'preppy crisp white and green tennis look',
      'watching pro tennis from the stands',
    ],
  },
  {
    key: 'horse-race-derby-day',
    occasion: 'statement Southern-classic daytime finery for derby day races',
    budget: { men: 215, women: 225 },
    wordings: [
      'Kentucky Derby trackside outfit',
      'bold pastel dressy fit for horse races',
      'statement hat and floral derby day look',
      'preppy Southern races attire',
    ],
  },
  {
    key: 'soccer-watch-party',
    occasion: 'relaxed sporty pub outfit for a soccer watch party',
    budget: { men: 100, women: 100 },
    wordings: [
      'watching the big match at a sports pub',
      'World Cup or Premier League watch party fit',
      'casual sporty outfit to cheer on my team',
      'relaxed pub game day look',
    ],
  },

  // Culture and community (6)
  {
    key: 'religious-service',
    occasion: 'modest respectful polished attire for a weekly religious service',
    budget: { men: 145, women: 140 },
    wordings: [
      'Sunday church service outfit',
      'respectful modest look for temple or mosque',
      'neat traditional fit for worship',
      'polished family service attire',
    ],
  },
  {
    key: 'funeral-or-memorial',
    occasion: 'dignified understated dark attire for a funeral memorial',
    budget: { men: 175, women: 165 },
    wordings: [
      'respectful all black outfit for a funeral',
      'conservative dark clothes for a memorial service',
      'dignified understated look for a celebration of life',
      'what to wear to pay respects at a service',
    ],
  },
  {
    key: 'parent-teacher-meeting',
    occasion: 'approachable neat daytime outfit for a parent-teacher conference',
    budget: { men: 125, women: 120 },
    wordings: [
      "parent-teacher night at my kid's school",
      'put together approachable mom or dad fit',
      'neat casual look for school meetings',
      'smart everyday outfit to meet the teachers',
    ],
  },
  {
    key: 'college-campus-visit',
    occasion: 'comfortable walkable smart-casual look for a college campus tour',
    budget: { men: 110, women: 110 },
    wordings: [
      'touring colleges this weekend',
      'cute walkable fit for an admissions campus visit',
      'smart casual outfit for walking around campus',
      'prospective student tour day look',
    ],
  },
  {
    key: 'volunteering-day',
    occasion: 'practical durable hands-on outfit for community volunteering',
    budget: { men: 85, women: 85 },
    wordings: [
      'volunteering at the food bank this morning',
      'practical clothes for a neighborhood cleanup',
      'comfy durable fit for a service day',
      'hands on charity shift outfit',
    ],
  },
  {
    key: 'art-class',
    occasion: 'creative easy-wash casual outfit for a hands-on art class',
    budget: { men: 90, women: 95 },
    wordings: [
      'pottery or painting class tonight',
      "cute artsy fit I don't mind getting paint on",
      'chill studio outfit for a ceramics workshop',
      'creative relaxed look for a drawing class',
    ],
  },

  // Creative and statement (6)
  {
    key: 'fashion-week-street-style',
    occasion: 'avant-garde editorial statement outfit for fashion week streets',
    budget: { men: 235, women: 245 },
    wordings: [
      'NYFW street style fit to get photographed',
      'high fashion editorial look for fashion week',
      'bold head turning statement outfit',
      'serving avant-garde looks outside the runway shows',
    ],
  },
  {
    key: 'music-video-extra',
    occasion: 'photogenic high-contrast streetwear look for a music video shoot',
    budget: { men: 165, women: 170 },
    wordings: [
      'cast as an extra in a music video',
      'hype camera-ready fit for a video shoot',
      'bold streetwear that pops on film',
      'edgy styling for a hip-hop or pop shoot',
    ],
  },
  {
    key: 'gallery-opening',
    occasion: 'artistic sleek evening outfit for a contemporary gallery opening',
    budget: { men: 185, women: 190 },
    wordings: [
      'art gallery opening reception in Chelsea',
      'cool minimalist artsy look for an exhibit launch',
      'wine and contemporary art opening fit',
      'creative black-forward outfit for a gallery night',
    ],
  },
  {
    key: 'dating-profile-shoot',
    occasion: 'flattering effortless photogenic outfit for dating profile photos',
    budget: { men: 145, women: 140 },
    wordings: [
      'taking new Hinge and Bumble profile pics',
      'flattering natural outfit for a dating photo shoot',
      'what photographs best for dating app pictures',
      'approachable attractive look for outdoor portraits',
    ],
  },
  {
    key: 'linkedin-headshot',
    occasion: 'clean timeless upper-body tailoring for professional LinkedIn headshots',
    budget: { men: 165, women: 155 },
    wordings: [
      'getting new LinkedIn headshots taken',
      'sharp professional top for corporate portraits',
      'timeless blazer look for a headshot session',
      'polished camera-friendly outfit for work photos',
    ],
  },
  {
    key: 'influencer-event',
    occasion: 'trend-forward photogenic outfit for a brand influencer launch',
    budget: { men: 195, women: 205 },
    wordings: [
      'invited to a brand launch influencer event',
      'Instagrammable trendy fit for a PR party',
      'content creator outfit for a pop-up launch',
      'chic aesthetic look for photos with brands',
    ],
  },
];
