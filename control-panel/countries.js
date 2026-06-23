/* ISO 3166-1 country list (alpha-2 code + name) shared by the control panel and the
 * flag-download script. Flags are stored locally at assets/flags/<code>.svg (see
 * scripts/download-flags.js); flagSrc() falls back to flagcdn.com if a file is missing.
 * Player.country stores the lowercase alpha-2 code so overlays can render the flag too. */
const COUNTRIES = [
  { c: 'af', n: 'Afghanistan' }, { c: 'al', n: 'Albania' }, { c: 'dz', n: 'Algeria' },
  { c: 'ad', n: 'Andorra' }, { c: 'ao', n: 'Angola' }, { c: 'ag', n: 'Antigua and Barbuda' },
  { c: 'ar', n: 'Argentina' }, { c: 'am', n: 'Armenia' }, { c: 'au', n: 'Australia' },
  { c: 'at', n: 'Austria' }, { c: 'az', n: 'Azerbaijan' }, { c: 'bs', n: 'Bahamas' },
  { c: 'bh', n: 'Bahrain' }, { c: 'bd', n: 'Bangladesh' }, { c: 'bb', n: 'Barbados' },
  { c: 'by', n: 'Belarus' }, { c: 'be', n: 'Belgium' }, { c: 'bz', n: 'Belize' },
  { c: 'bj', n: 'Benin' }, { c: 'bt', n: 'Bhutan' }, { c: 'bo', n: 'Bolivia' },
  { c: 'ba', n: 'Bosnia and Herzegovina' }, { c: 'bw', n: 'Botswana' }, { c: 'br', n: 'Brazil' },
  { c: 'bn', n: 'Brunei' }, { c: 'bg', n: 'Bulgaria' }, { c: 'bf', n: 'Burkina Faso' },
  { c: 'bi', n: 'Burundi' }, { c: 'kh', n: 'Cambodia' }, { c: 'cm', n: 'Cameroon' },
  { c: 'ca', n: 'Canada' }, { c: 'cv', n: 'Cape Verde' }, { c: 'cf', n: 'Central African Republic' },
  { c: 'td', n: 'Chad' }, { c: 'cl', n: 'Chile' }, { c: 'cn', n: 'China' },
  { c: 'co', n: 'Colombia' }, { c: 'km', n: 'Comoros' }, { c: 'cg', n: 'Congo' },
  { c: 'cd', n: 'Congo (DR)' }, { c: 'cr', n: 'Costa Rica' }, { c: 'ci', n: "Côte d'Ivoire" },
  { c: 'hr', n: 'Croatia' }, { c: 'cu', n: 'Cuba' }, { c: 'cy', n: 'Cyprus' },
  { c: 'cz', n: 'Czechia' }, { c: 'dk', n: 'Denmark' }, { c: 'dj', n: 'Djibouti' },
  { c: 'dm', n: 'Dominica' }, { c: 'do', n: 'Dominican Republic' }, { c: 'ec', n: 'Ecuador' },
  { c: 'eg', n: 'Egypt' }, { c: 'sv', n: 'El Salvador' }, { c: 'gq', n: 'Equatorial Guinea' },
  { c: 'er', n: 'Eritrea' }, { c: 'ee', n: 'Estonia' }, { c: 'sz', n: 'Eswatini' },
  { c: 'et', n: 'Ethiopia' }, { c: 'fj', n: 'Fiji' }, { c: 'fi', n: 'Finland' },
  { c: 'fr', n: 'France' }, { c: 'ga', n: 'Gabon' }, { c: 'gm', n: 'Gambia' },
  { c: 'ge', n: 'Georgia' }, { c: 'de', n: 'Germany' }, { c: 'gh', n: 'Ghana' },
  { c: 'gr', n: 'Greece' }, { c: 'gd', n: 'Grenada' }, { c: 'gt', n: 'Guatemala' },
  { c: 'gn', n: 'Guinea' }, { c: 'gw', n: 'Guinea-Bissau' }, { c: 'gy', n: 'Guyana' },
  { c: 'ht', n: 'Haiti' }, { c: 'hn', n: 'Honduras' }, { c: 'hk', n: 'Hong Kong' },
  { c: 'hu', n: 'Hungary' }, { c: 'is', n: 'Iceland' }, { c: 'in', n: 'India' },
  { c: 'id', n: 'Indonesia' }, { c: 'ir', n: 'Iran' }, { c: 'iq', n: 'Iraq' },
  { c: 'ie', n: 'Ireland' }, { c: 'il', n: 'Israel' }, { c: 'it', n: 'Italy' },
  { c: 'jm', n: 'Jamaica' }, { c: 'jp', n: 'Japan' }, { c: 'jo', n: 'Jordan' },
  { c: 'kz', n: 'Kazakhstan' }, { c: 'ke', n: 'Kenya' }, { c: 'ki', n: 'Kiribati' },
  { c: 'kp', n: 'Korea (North)' }, { c: 'kr', n: 'Korea (South)' }, { c: 'xk', n: 'Kosovo' },
  { c: 'kw', n: 'Kuwait' }, { c: 'kg', n: 'Kyrgyzstan' }, { c: 'la', n: 'Laos' },
  { c: 'lv', n: 'Latvia' }, { c: 'lb', n: 'Lebanon' }, { c: 'ls', n: 'Lesotho' },
  { c: 'lr', n: 'Liberia' }, { c: 'ly', n: 'Libya' }, { c: 'li', n: 'Liechtenstein' },
  { c: 'lt', n: 'Lithuania' }, { c: 'lu', n: 'Luxembourg' }, { c: 'mo', n: 'Macau' },
  { c: 'mg', n: 'Madagascar' }, { c: 'mw', n: 'Malawi' }, { c: 'my', n: 'Malaysia' },
  { c: 'mv', n: 'Maldives' }, { c: 'ml', n: 'Mali' }, { c: 'mt', n: 'Malta' },
  { c: 'mh', n: 'Marshall Islands' }, { c: 'mr', n: 'Mauritania' }, { c: 'mu', n: 'Mauritius' },
  { c: 'mx', n: 'Mexico' }, { c: 'fm', n: 'Micronesia' }, { c: 'md', n: 'Moldova' },
  { c: 'mc', n: 'Monaco' }, { c: 'mn', n: 'Mongolia' }, { c: 'me', n: 'Montenegro' },
  { c: 'ma', n: 'Morocco' }, { c: 'mz', n: 'Mozambique' }, { c: 'mm', n: 'Myanmar' },
  { c: 'na', n: 'Namibia' }, { c: 'nr', n: 'Nauru' }, { c: 'np', n: 'Nepal' },
  { c: 'nl', n: 'Netherlands' }, { c: 'nz', n: 'New Zealand' }, { c: 'ni', n: 'Nicaragua' },
  { c: 'ne', n: 'Niger' }, { c: 'ng', n: 'Nigeria' }, { c: 'mk', n: 'North Macedonia' },
  { c: 'no', n: 'Norway' }, { c: 'om', n: 'Oman' }, { c: 'pk', n: 'Pakistan' },
  { c: 'pw', n: 'Palau' }, { c: 'ps', n: 'Palestine' }, { c: 'pa', n: 'Panama' },
  { c: 'pg', n: 'Papua New Guinea' }, { c: 'py', n: 'Paraguay' }, { c: 'pe', n: 'Peru' },
  { c: 'ph', n: 'Philippines' }, { c: 'pl', n: 'Poland' }, { c: 'pt', n: 'Portugal' },
  { c: 'pr', n: 'Puerto Rico' }, { c: 'qa', n: 'Qatar' }, { c: 'ro', n: 'Romania' },
  { c: 'ru', n: 'Russia' }, { c: 'rw', n: 'Rwanda' }, { c: 'kn', n: 'Saint Kitts and Nevis' },
  { c: 'lc', n: 'Saint Lucia' }, { c: 'vc', n: 'Saint Vincent and the Grenadines' },
  { c: 'ws', n: 'Samoa' }, { c: 'sm', n: 'San Marino' }, { c: 'st', n: 'São Tomé and Príncipe' },
  { c: 'sa', n: 'Saudi Arabia' }, { c: 'sn', n: 'Senegal' }, { c: 'rs', n: 'Serbia' },
  { c: 'sc', n: 'Seychelles' }, { c: 'sl', n: 'Sierra Leone' }, { c: 'sg', n: 'Singapore' },
  { c: 'sk', n: 'Slovakia' }, { c: 'si', n: 'Slovenia' }, { c: 'sb', n: 'Solomon Islands' },
  { c: 'so', n: 'Somalia' }, { c: 'za', n: 'South Africa' }, { c: 'ss', n: 'South Sudan' },
  { c: 'es', n: 'Spain' }, { c: 'lk', n: 'Sri Lanka' }, { c: 'sd', n: 'Sudan' },
  { c: 'sr', n: 'Suriname' }, { c: 'se', n: 'Sweden' }, { c: 'ch', n: 'Switzerland' },
  { c: 'sy', n: 'Syria' }, { c: 'tw', n: 'Taiwan' }, { c: 'tj', n: 'Tajikistan' },
  { c: 'tz', n: 'Tanzania' }, { c: 'th', n: 'Thailand' }, { c: 'tl', n: 'Timor-Leste' },
  { c: 'tg', n: 'Togo' }, { c: 'to', n: 'Tonga' }, { c: 'tt', n: 'Trinidad and Tobago' },
  { c: 'tn', n: 'Tunisia' }, { c: 'tr', n: 'Turkey' }, { c: 'tm', n: 'Turkmenistan' },
  { c: 'tv', n: 'Tuvalu' }, { c: 'ug', n: 'Uganda' }, { c: 'ua', n: 'Ukraine' },
  { c: 'ae', n: 'United Arab Emirates' }, { c: 'gb', n: 'United Kingdom' },
  { c: 'gb-eng', n: 'England' }, { c: 'gb-sct', n: 'Scotland' }, { c: 'gb-wls', n: 'Wales' },
  { c: 'gb-nir', n: 'Northern Ireland' }, { c: 'us', n: 'United States' },
  { c: 'uy', n: 'Uruguay' }, { c: 'uz', n: 'Uzbekistan' }, { c: 'vu', n: 'Vanuatu' },
  { c: 've', n: 'Venezuela' }, { c: 'vn', n: 'Vietnam' }, { c: 'ye', n: 'Yemen' },
  { c: 'zm', n: 'Zambia' }, { c: 'zw', n: 'Zimbabwe' }
];

// Local flag path (bundled by scripts/download-flags.js). The <img> using this should set an
// onerror fallback to https://flagcdn.com/<code>.svg so it still shows before flags are downloaded.
function flagSrc(code) {
  return code ? `../assets/flags/${String(code).toLowerCase()}.svg` : '';
}
function flagCdn(code) {
  return code ? `https://flagcdn.com/${String(code).toLowerCase()}.svg` : '';
}
function countryName(code) {
  if (!code) return '';
  const m = COUNTRIES.find((x) => x.c === String(code).toLowerCase());
  return m ? m.n : String(code).toUpperCase();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COUNTRIES, flagSrc, flagCdn, countryName };
}
