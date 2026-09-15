'use strict';

// 8 centres in Medak district. APMC mandi centres run a dedicated
// weighbridge; PACS/IKP village-level centres weigh on a platform, so
// throughput scales with lot size instead of a fixed cycle time.
//
// Each profile is deliberately tuned to be tight on one constraint (see
// `intendedBottleneck`) by leaving every other constraint generously
// sized. The seed script runs the real capacity engine over these
// numbers rather than asserting the outcome -- `intendedBottleneck` is a
// label for readability, not a fact injected into the data.
const SHARED_BASELINE = {
  weighbridgeOperatingMinutes: 480, // 8-hour day
  hamaliGangCount: 15,
  hamaliBagsPerGangPerDay: 800,
  bagsPerTruck: 200, // 200 x 50kg bags = 10t
  gunnyBagsAvailable: 20000,
  truckEvacuationCapacity: 60,
  yardCapacityTonnes: 1000,
  undispatchedTonnes: 50,
  avgTruckLoadTonnes: 10,
  moistureMeterCount: 4,
  moistureTestsPerMeterPerDay: 150, // 600/day -- never the tightest constraint
};

// Approximate coordinates for the mandal towns -- close enough to place
// centres realistically within Medak district and to give the 25km
// nearby-centre search a genuine mix of near and far pairs. Not surveyed.
const CENTRES = [
  {
    name: 'Medak APMC Mandi',
    nameHi: 'मेडक एपीएमसी मंडी',
    nameTe: 'మెదక్ ఏపీఎంసీ మండి',
    code: 'MDK-APMC-01',
    centreType: 'apmc_mandi',
    weighingMode: 'weighbridge',
    lat: 18.0455,
    lng: 78.2665,
    intendedBottleneck: 'weighbridge (slow cycle time)',
    overrides: { weighbridgeAvgCycleMinutes: 10 },
  },
  {
    name: 'Narsapur APMC Mandi',
    nameHi: 'नरसापुर एपीएमसी मंडी',
    nameTe: 'నర్సాపూర్ ఏపీఎంసీ మండి',
    code: 'MDK-APMC-02',
    centreType: 'apmc_mandi',
    weighingMode: 'weighbridge',
    lat: 18.1459,
    lng: 78.2971,
    intendedBottleneck: 'gunny (bardana shortage)',
    overrides: { weighbridgeAvgCycleMinutes: 6, gunnyBagsAvailable: 3000 },
  },
  {
    name: 'Ramayampet APMC Mandi',
    nameHi: 'रामायमपेट एपीएमसी मंडी',
    nameTe: 'రామాయంపేట్ ఏపీఎంసీ మండి',
    code: 'MDK-APMC-03',
    centreType: 'apmc_mandi',
    weighingMode: 'weighbridge',
    lat: 18.2934,
    lng: 78.4432,
    intendedBottleneck: 'truckEvacuation (few trucks assigned)',
    overrides: { weighbridgeAvgCycleMinutes: 6, truckEvacuationCapacity: 25 },
  },
  {
    name: 'Toopran PACS Centre',
    nameHi: 'टूपरान पैक्स केंद्र',
    nameTe: 'టూప్రాన్ పాక్స్ కేంద్రం',
    code: 'MDK-PACS-01',
    centreType: 'pacs',
    weighingMode: 'platform',
    lat: 17.8672,
    lng: 78.4634,
    intendedBottleneck: 'yardSpace (rain backlog, undispatched stock)',
    overrides: { secondsPerBag: 5, avgBagsPerLot: 20, undispatchedTonnes: 850 },
  },
  {
    name: 'Chegunta PACS Centre',
    nameHi: 'चेगुंटा पैक्स केंद्र',
    nameTe: 'చేగుంట పాక్స్ కేంద్రం',
    code: 'MDK-PACS-02',
    centreType: 'pacs',
    weighingMode: 'platform',
    lat: 17.8703,
    lng: 78.4001,
    intendedBottleneck: 'hamali (short-staffed gangs)',
    overrides: { secondsPerBag: 5, avgBagsPerLot: 20, hamaliGangCount: 3 },
  },
  {
    name: 'Yeldurthy PACS Centre',
    nameHi: 'येलदुर्थी पैक्स केंद्र',
    nameTe: 'ఎల్దుర్తి పాక్స్ కేంద్రం',
    code: 'MDK-PACS-03',
    centreType: 'pacs',
    weighingMode: 'platform',
    lat: 18.0102,
    lng: 78.0512,
    intendedBottleneck: 'truckEvacuation (remote, few trucks reach it)',
    overrides: { secondsPerBag: 5, avgBagsPerLot: 20, truckEvacuationCapacity: 10 },
  },
  {
    name: 'Shivampet IKP Centre',
    nameHi: 'शिवमपेट आईकेपी केंद्र',
    nameTe: 'శివంపేట్ ఐకేపీ కేంద్రం',
    code: 'MDK-IKP-01',
    centreType: 'ikp',
    weighingMode: 'platform',
    lat: 17.9531,
    lng: 78.1523,
    intendedBottleneck: 'weighbridge (large lots slow platform weighing)',
    overrides: { secondsPerBag: 12, avgBagsPerLot: 80 },
  },
  {
    name: 'Kowdipally IKP Centre',
    nameHi: 'कौडीपल्ली आईकेपी केंद्र',
    nameTe: 'కౌడిపల్లి ఐకేపీ కేంద్రం',
    code: 'MDK-IKP-02',
    centreType: 'ikp',
    weighingMode: 'platform',
    lat: 17.8347,
    lng: 78.6022,
    intendedBottleneck: 'yardSpace (small village-level yard)',
    overrides: { secondsPerBag: 5, avgBagsPerLot: 20, yardCapacityTonnes: 200, undispatchedTonnes: 20 },
  },
];

module.exports = { SHARED_BASELINE, CENTRES };
