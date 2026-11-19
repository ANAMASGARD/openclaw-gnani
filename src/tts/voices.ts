export const TIMBRE_MODELS = ["timbre-v2.5", "timbre-v3.0"] as const;
export type TimbreModel = typeof TIMBRE_MODELS[number];
export const DEFAULT_TIMBRE = "timbre-v3.0";

const V25_VOICES = {
  "en-IN": "Kaveri Trupti Devika Pranav Shlok Girish",
  "hi-IN": "Nalini Bhavna Yashvi Urmila Jwala Chitra Ambuja Deepak Roopesh Vikrant Hemraj Jalaj Omkar",
  "hi-en": "Poorvi",
  "ta-IN": "Asmita Trisha Brinda Vedika Noopur",
  "te-IN": "Suhana Lehara Lavanya Yukti Varuni",
  "kn-IN": "Saanvi Kavin",
  "ml-IN": "Reshma Riyaan",
  "mr-IN": "Zahira Ishaan",
  "bn-IN": "Kirra Dhruva",
  "gu-IN": "Falak Veera",
  "pa-IN": "Mehuli Zayan",
};

export const VOICES = {
  "timbre-v2.5": Object.entries(V25_VOICES).flatMap(([locale, voices]) =>
    voices.split(" ").map((id) => ({ id, name: id, locale })),
  ),
  "timbre-v3.0": (
    "Anitasingh Chetana Kalpana Lakshmi Lakshmidevi Neelam Priyasharm Rajni Rekha Riyaa Shivani Shruthi Sneha Sohini Sunaina Swathi Tarika Vasudha " +
    "Arko Avinash Devansh Harshad Mahendra Manjunath Nitin Prakash Rahulmehta Rajeev Rakesh Santosh Shubham Vikramdasu Vinod Yashraj"
  ).split(" ").map((id) => ({ id, name: id })),
};
