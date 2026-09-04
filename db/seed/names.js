'use strict';

// Synthetic Telugu name pools for seed data generation -- not drawn from
// or representing any real person.
const MALE_FIRST_NAMES = [
  'Ravi', 'Suresh', 'Ramesh', 'Srinivas', 'Venkatesh', 'Nagesh', 'Mahesh', 'Rajesh',
  'Kiran', 'Prasad', 'Krishna', 'Anil', 'Sunil', 'Naveen', 'Praveen', 'Ravindra',
  'Nagaraju', 'Yadagiri', 'Sathish', 'Vijay', 'Ashok', 'Ramulu', 'Narsimha', 'Balaraju',
  'Lakshman', 'Ganesh', 'Srikanth', 'Anjaneyulu', 'Bhaskar', 'Chandu',
];

const FEMALE_FIRST_NAMES = [
  'Lakshmi', 'Padma', 'Sarala', 'Anitha', 'Sunitha', 'Swarna', 'Rajitha', 'Vani',
  'Bharathi', 'Kavitha', 'Sridevi', 'Manjula', 'Radha', 'Saroja', 'Rama', 'Sujatha',
  'Vasantha', 'Yashoda', 'Indira', 'Jyothi', 'Shailaja', 'Pushpa', 'Nirmala', 'Aruna',
  'Padmavathi', 'Sudha', 'Vijaya', 'Kalpana', 'Renuka', 'Sumathi',
];

const FIRST_NAMES = [...MALE_FIRST_NAMES, ...FEMALE_FIRST_NAMES];

const SURNAMES = [
  'Reddy', 'Rao', 'Goud', 'Yadav', 'Naik', 'Chary', 'Varma', 'Raju',
  'Naidu', 'Kumar', 'Prasad', 'Swamy', 'Sastry', 'Murthy', 'Charyulu',
];

const VILLAGE_PREFIXES = [
  'Ramannapet', 'Konda', 'Chinna', 'Pedda', 'Gollapally', 'Kondapur', 'Narsapur',
  'Timmapur', 'Vempet', 'Shankar', 'Yenkepally', 'Manoharabad', 'Rangapur', 'Devunipally',
  'Bommala', 'Erragadda', 'Kollapur', 'Basanth', 'Muthyala', 'Ankireddy',
];

const VILLAGE_SUFFIXES = ['pally', 'guda', 'pet', 'oor', 'wada', 'gadda', 'thanda'];

function generateVillageNames(rng, count) {
  const names = new Set();
  while (names.size < count) {
    names.add(`${rng.pick(VILLAGE_PREFIXES)}${rng.pick(VILLAGE_SUFFIXES)}`);
  }
  return Array.from(names);
}

function generatePersonName(rng) {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(SURNAMES)}`;
}

function generateFatherName(rng) {
  return `${rng.pick(MALE_FIRST_NAMES)} ${rng.pick(SURNAMES)}`;
}

module.exports = {
  FIRST_NAMES,
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  SURNAMES,
  generateVillageNames,
  generatePersonName,
  generateFatherName,
};
