/* ==========================================================================
   LoveStory — seed memories, for TESTS ONLY

   This used to be the archive's content. It is not any more: the archive is
   whatever the database holds, and nothing here is loaded by any page.

   It survives so the automated suites have a known, fixed set of memories to
   assert against. A test opts in explicitly with
   `LoveStoryData.useSeedFixtures(window.LOVE_STORY_SEED)` — production never
   calls it, so production never sees these memories.

   Do not import this file from a page.
   ========================================================================== */

window.LOVE_STORY_SEED = [
        {
            id: "first-meeting",
            year: 2025,
            date: "2025-06-12",
            time: "19:30",
            title: "The First Meeting",
            location: null,
            photos: [],
            category: "first",
            momentType: "first",
            collections: ["Our Firsts", "Important"],
            mood: "Emotional",
            tags: ["First", "2025"],
            weather: { condition: "", temperature: null },
            milestone: true,
            showOnTimeline: true,
            description: "Hotpot, then the ocean museum. Neither of us knew what it was yet."
        },
        {
            id: "first-trip",
            year: 2025,
            date: "2025-08-10",
            time: "09:20",
            title: "The First Trip",
            location: {
                country: "China", countryCode: "156",
                city: "Hulunbeier", placeName: "Hulunbeier",
                latitude: 49.2122, longitude: 119.7658
            },
            photos: ["hulunpicture1.jpeg", "hulunpicture2.jpeg"],
            category: "travel",
            momentType: "trip",
            collections: ["Trips", "Our Firsts", "Happy Moments"],
            mood: "Happy",
            tags: ["Travel", "Hulunbeier"],
            weather: { condition: "Sunny", temperature: 18 },
            favorite: true,
            milestone: true,
            showOnTimeline: true,
            description: "Two days of planning, then a rented car and the grassland."
        },
        {
            id: "disconnect",
            year: 2025,
            date: "2025-10-05",
            time: "",
            title: "Disconnect",
            location: null,
            photos: [],
            category: "moment",
            momentType: "important",
            collections: ["Important"],
            mood: "Difficult",
            tags: ["Us"],
            weather: { condition: "", temperature: null },
            showOnTimeline: true,
            description: "A quiet stretch that neither of us talks about much."
        },
        {
            id: "maldives",
            year: 2026,
            date: "2026-02-17",
            time: "16:40",
            title: "Maldives",
            location: {
                country: "Maldives", countryCode: "462",
                city: "Male", placeName: "Male",
                latitude: 4.1755, longitude: 73.5093
            },
            photos: ["maerdaifu3.jpeg", "maerdaifu4.jpeg"],
            category: "travel",
            momentType: "trip",
            collections: ["Trips", "Happy Moments"],
            mood: "Romantic",
            tags: ["Travel", "Maldives", "Spring Festival"],
            weather: { condition: "Sunny", temperature: 26 },
            favorite: true,
            milestone: true,
            showOnTimeline: true,
            description: "White sand, shallow water, and a dress that matched the flowers."
        },

        /* --- SAMPLE — replace with your own memories --------------------- */
        {
            id: "chengdu",
            year: 2025,
            date: "2025-03-02",
            time: "15:10",
            title: "Chengdu",
            location: {
                country: "China", countryCode: "156",
                city: "Chengdu", placeName: "Chengdu",
                latitude: 30.5728, longitude: 104.0668
            },
            photos: [],
            category: "travel",
            momentType: "trip",
            collections: ["Trips"],
            mood: "Peaceful",
            tags: ["Travel", "Chengdu"],
            weather: { condition: "Cloudy", temperature: 22 },
            showOnTimeline: true,
            sample: true,
            description: ""
        },
        {
            id: "tokyo",
            year: 2026,
            date: "2026-05-18",
            time: "11:05",
            title: "Tokyo",
            location: {
                country: "Japan", countryCode: "392",
                city: "Tokyo", placeName: "Tokyo",
                latitude: 35.6762, longitude: 139.6503
            },
            photos: [],
            category: "travel",
            momentType: "trip",
            collections: ["Trips"],
            mood: "Excited",
            tags: ["Travel", "Tokyo"],
            weather: { condition: "Rainy", temperature: 19 },
            showOnTimeline: true,
            sample: true,
            description: ""
        },
        {
            id: "brisbane",
            year: 2026,
            date: "2026-08-06",
            time: "13:25",
            title: "Brisbane",
            location: {
                country: "Australia", countryCode: "036",
                city: "Brisbane", placeName: "Brisbane",
                latitude: -27.4698, longitude: 153.0251
            },
            photos: ["lastshowering.jpeg"],
            category: "travel",
            momentType: "trip",
            collections: ["Trips", "Happy Moments"],
            mood: "Funny",
            tags: ["Travel", "Brisbane"],
            weather: { condition: "Windy", temperature: 24 },
            showOnTimeline: true,
            sample: true,
            description: "The alpaca, of all things, is what we still send each other."
        }
    ];;
