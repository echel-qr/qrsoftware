'use strict';
/*
 * hinglish.js — recognises Hindi written in Latin letters ("Hinglish").
 *
 * The whole product — pages, error messages, logs, reports, e-mails and the
 * source code itself — is written in English. Manipuri is added through the
 * translation dictionary, never by writing another language into the source.
 * test/no-hinglish.test.js uses this file to keep it that way.
 *
 * A piece of text counts as Hinglish when it contains:
 *   - any Devanagari letter, or
 *   - one strong word (a Hindi verb / pronoun that is not an English word), or
 *   - two Hindi function words, or one of them in a short piece of text, or
 *   - three weak words of at least two different kinds.
 *
 * The lists below are deliberately long: every word here was found in this
 * codebase at some point. Adding a word is cheap, so add one whenever a
 * Hinglish word slips through.
 */

// Hindi words that are never English words — one is enough.
const STRONG = `
kar karo karein karen kare karna karni karne karke karte karta karti kiya kiye kijiye karwa karwao karwana karega karegi karenge
kro krna krne krke krta krte nhi rha rhi rhe
hoga hogi honge hoge hota hoti hote hua hui hue hona hoke hokar hoon
raha rahi rahe rehta rehti rehte rehna rehne rakh rakho rakhe rakhna rakhne rakha rakhi rakhte rakhta rakhein
jaata jaati jaate jata jati jate jayega jayegi jaayega jaayegi jaega jaegi jaenge jayenge jaana jaane jaaye jaye
aata aati aate aaya aayi aaye aana aane aayega aayegi aaega
gaya gayi gaye gya gyi diya diye dena dene deta deti dete dega degi denge dijiye dijie dein
lene leta leti lete lega legi lenge lijiye liya lein liye
dekh dekho dekhe dekhna dekhne dekhta dekhti dekhte dekhein dikhe dikhta dikhti dikhte dikhega dikhegi dikhao dikhana dikhane dikhaya dikhai dikhenge
milta milti milte milega milegi milenge milna milne
bhej bhejo bhejna bhejne bheja bheji bheje bhejta bhejte bhejega bhejenge bhejein
daal daalo dalo daalna daalne daala daali daale daalein daalte daalta
likh likho likha likhi likhe likhna likhne likhein likhte likhta
padh padho padhna padhne suno bolo batao bataye bataya batana batane poocho pucho puchho
chalo chala chali chalta chalti chalte chalega chalegi chalenge chalu chaalu chalana chalane
ruko ruka ruki rukta rukti rukte rukega rukegi rukna rukne roko roka roki rokna rokne
badlo badla badli badle badalna badalne badalta badalti badalte badlein
hatao hata hati hatana hatane hataya hatayi hatega hategi hatein
lagao lagta lagti lagte lagega lagegi lagenge lagana lagane lagaya
bharo bharna bharne bharta bharti bharein
chuno chuna chuni chune chunein chunna chunne chunte chunta
samjho samjha samjhe samajh samajhna nikalo nikla nikli nikle nikalna nikalta nikalti nikalte nikalega
bana banao banega banegi banenge banta banti bante banaya banayi banaye
sakta sakti sakte sakoge sakenge sako
chahiye chahie chahte chahta chahti chaho chahe chahein chaahiye
padta padti padte padega padegi padenge
jodo joda jode jodna jodne jodta jodte
khatam kholo khola kholi khole kholna kholne khulta khulti khulte khulega khulegi
chhod chhodo chodo chhoda chhodna chhodne chhodte chhodta
uthao uthana uthaya socho sochna sochta sochte
aap aapka aapki aapke aapko aapse apka apki apke apna apni apne apko humara hamara hamari hamare humari humne hamne
mera meri mujhe tumhara tumhari tumhe tumko uska uski uske usko usse iska iski iske isko isse inka inki inke inko unka unki unke unko unhe inhe
woh yeh koi kuch kuchh sabko sabse sabki kisi kisko kaun kaunsa kaunsi jise jisko jisse jiska jiski jiske jinka jinhe jinko
kya kyun kyon kyunki kyonki kaise kaisa kaisi kahan jahan jaha yahan yaha wahan waha idhar udhar
kitna kitni kitne jitna jitni jitne itna itni itne utna utni utne
aur lekin magar phir agar toh bhi sirf bilkul zaroor zaroori zaruri jaruri turant abhi pehle pahle baad saath sath
bina warna varna isliye isiliye taaki jaise jaisa jaisi waisa waise aise aisa aisi vaise bahut bohot thoda thodi thode
zyada jyada kaafi kafi dobara dubara wapas waapas andar bahar upar neeche saamne samne
ghanta ghante mahina mahine hamesha kabhi tabhi jabhi sabhi haan nahi nahin kab ek
pehla pehli dusra doosra dusri dusre doosre teesra agla agle agli pichla pichle pichhle pichli
dukaan dukan dukaanon kaam rupaye rupaya kagaz kaagaz panne naam jagah tarah cheez cheezein galti galat sahi theek thik
badlav badlaav jaankari jankari madad sawal jawab baat grahak maalik kharcha kamai samasya dikkat pareshani jaldi intezaar intezar
dhyan dhyaan kripya dhanyavaad dhanyawad shukriya namaste bhasha likhawat gadbad khaali khali poora poori dono teeno chaaro sabka
matlab shayad zarurat zaroorat jarurat jaroorat tarika tarike tareeka wajah nishan nishaan yaani yani lagbhag kareeb karib
saaf mitao mitana shuru khud asli nakli sasta mehenga mehnga pakka pakki hisaab hisab seedha seedhi sidha sidhi ulta ulti
chhota chhoti chhote chota choti chote bada badi bade naya nayi naye purana purani purane ghar bhai arre arey yaar acha accha achha achchha
mein wala wali wale waala waali waale vala vali
hain hai tha thi taraf tarf jaan
alag nikal isi paas wahi dabao baaki saare aaj jao yahi badal hafte roz banane dikh wasool bado becho humare akshar yahin chuka khul
chaaron rahegi rahega saari usme banein bhar jaakar waqt bech dikhne isme usi kariye naksha karoge dhundo banne raho humse jhanjhat sabke
chipkao jaao baje niklega hongi kaunse jaake loge milengi yaad bhool juda jud walon walo doosri mehnat puchhe seedhe mangna aksar sawaal balki
aasan bicholiye khatra bolega kamao pahunch maangi wahaan atak jaanna daba katega ginti raat tez ghumana kaatna ujaala gehra jodna motai kaatne
aasani tirchha badho badh koshish padhi saki paayi nazar rukna raste deri puchh halki aayegi dikhengi payegi zindagi pasand badhein taiyaar
banegi dekhegi banega rehne nikalna khulegi khuli payenge chhutti khush honi kamaya bhaari jisse bano dilwao badhao puchhta bikti lagat banata
bharta dhanda lagaye bachao palto bolta katta dikhenge bachegi jaayengi chhapta palat milaake banayega khulne jisme leni chalengi dhundh sakein
paaye wahin niklenge awaaz chuke kehte chalti pahunchega saral poochna pooche utha khota khicho kahani chalate bhejte bechne mahino bharose
dhundhte baith jhagda bheed khade baithe kholna dabana banaye bharosa haath misaal taur bachat mujhse jhela ghanto milkar suvidha judne raaste
chalao pehchan sambhal jaoge ghadi chupchap lagte kahaan dikhegi pahunchti pichhla kheench chalana badalni pahuncho badha chaar gayab subah shaam
halat laata pahunchta bechta humein shahar bhejne tarjuma dhoondo badhiya nikaal jinke unpe asar shamil judenge bhejein daala karenge chhupa khula
ise kholta kheencho bharosemand bachta patli dekhta jodne chunte poore paata rahengi chhoda kisiko chaaho daalne padti hazaron baithi rokne aadmi
hataye shak daayre pada banda khole soorat chaura jaal dard kahin laga mila kis deewar shikayat farak vaakya tukdon niyam faisla darwaza chheda
bacha bache bachi bachey bachenge bachna dena lena mana gina chuno rakkha likhna sunna dikhna milna banna
saal saalon hafta hafte shabd shabdon bani bane
ghumao ghumaiye ghumaye palten bhario likhiye dekhiye suniye boliye chaliye ruiye ghumaao ghoomao kul kulmila mili milaa shaamil saamil aakhri akhri hissa hisse bika biki bikta jaiye jaaiye jaiyega bhaiya bhaiyya didi
`;

// Hindi function words that almost never stand alone in English.
const WEAK_A = `ka ki ke ko se pe tak jo wo sab kal din baar ho nai ji ab kai hum bas na`;

// Ambiguous on their own in English; they only count together with other evidence.
const WEAK = `me par mat tab jab ya pura puri pure hone lena mere jodi paisa paise vale chal kaha pata beech ander hun der bane sake ye`;

function words(list) {
  return list.split(/\s+/).map(w => w.trim()).filter(Boolean);
}

const strongList = [...new Set(words(STRONG))];
const weakAList = [...new Set(words(WEAK_A))];
const weakList = [...new Set(words(WEAK))];
// A word boundary that also refuses digits and underscores, so an id such as
// "SHOP_ECB1AB8A" does not read as the Hindi word "ab".
const B = '(?<![A-Za-z0-9_])(', E = ')(?![A-Za-z0-9_])';
const strongRe = new RegExp(B + strongList.join('|') + E, 'gi');
const weakRe = new RegExp(B + weakList.join('|') + E, 'gi');
const weakARe = new RegExp(B + weakAList.join('|') + E, 'gi');
const devanagariRe = /[ऀ-ॿ]/;

// URLs, e-mail addresses, escape sequences and brand names are not prose.
function prose(text) {
  return String(text)
    .replace(/PDF\s*Banao/gi, ' ')                                   // a partner's brand name
    .replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, ' ') // embedded files
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
    .replace(/\\[nrt]/g, ' ');
}

function score(text) {
  const t = prose(text || '');
  const strong = (t.match(strongRe) || []).map(s => s.toLowerCase());
  const weak = (t.match(weakRe) || []).map(s => s.toLowerCase());
  const weakA = (t.match(weakARe) || []).map(s => s.toLowerCase());
  const nWords = (t.match(/[A-Za-z]+/g) || []).length;
  return { strong, weak, weakA, nWords, devanagari: devanagariRe.test(t) };
}

function isHinglish(text) {
  const r = score(text);
  if (r.devanagari) return true;
  if (r.strong.length >= 1) return true;
  if (r.weakA.length >= 2) return true;
  if (r.weakA.length >= 1 && r.nWords <= 6) return true;
  const all = r.weak.concat(r.weakA);
  return all.length >= 3 && new Set(all).size >= 2;
}

// The words that made a piece of text count as Hinglish — for the report.
function hits(text) {
  const r = score(text);
  const out = r.strong.concat(r.weakA, r.weak);
  if (r.devanagari) out.unshift('(Devanagari)');
  return [...new Set(out)];
}

module.exports = { score, isHinglish, hits, strongList, weakList, weakAList };
