// Simple heuristic: no photo + no instructions + popular breed
const popularBreeds = new Set([
  'Golden Retriever','Labrador Retriever','German Shepherd','French Bulldog',
  'Poodle','Bulldog','Beagle','Rottweiler','Dachshund','German Shorthaired Pointer',
  'Yorkshire Terrier','Boxer','Siberian Husky','Shih Tzu','Chihuahua'
]);

export function isSuspiciousPet(pet){
  const noPhoto = !pet.photoUrl;
  const noInstr = !pet.instructions || !pet.instructions.trim();
  const popular = pet.breed ? popularBreeds.has(cap(pet.breed)) : false;
  return noPhoto && noInstr && popular;
}

function cap(s){ return s.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
