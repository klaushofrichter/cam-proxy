# Analytics classes

## Where the classes come from

Google does not publish the list of objects that object localization can
return. Its documentation says only that each result has a `mid`, a
machine-generated Knowledge Graph id
([object localizer](https://docs.cloud.google.com/vision/docs/object-localizer)).
A community answer in Google's Vision forum says the classes come from Open
Images ([forum thread](https://groups.google.com/g/cloud-vision-discuss/c/Gpo2h-Rw7gA));
no Google staff confirmed this.

Open Images publishes its 600 detection ("boxable") classes, each with a `mid`
([class-descriptions-boxable.csv](https://storage.googleapis.com/openimages/v5/class-descriptions-boxable.csv)).
Every object Google returned for cam1 on 2026-09-30 is in that list with the
same id: Person `/m/01g317`, Ceiling fan `/m/03ldnb`, Mechanical fan
`/m/02x984l`, Clothing `/m/09j2d`. So the list is very likely the one Vision
uses.

What it means for us: there is no "SUV", "Sedan" or "Baby" class. Those names
come from Google's web detection, a different feature, or from a guess.
Vehicles come as Car, Truck, Van and so on; animals as Dog, Cat, or the generic
Animal, Mammal, Carnivore.

## Mapping

Matching is by `mid`; the subtype is the class name in lower case. If a result
has no `mid`, its name is matched case-insensitively.

| Category | Class | mid |
|---|---|---|
| person | Person | `/m/01g317` |
| person | Man | `/m/04yx4` |
| person | Woman | `/m/03bt1vf` |
| person | Boy | `/m/01bl7v` |
| person | Girl | `/m/05r655` |
| vehicle | Car | `/m/0k4j` |
| vehicle | Truck | `/m/07r04` |
| vehicle | Van | `/m/0h2r6` |
| vehicle | Bus | `/m/01bjv` |
| vehicle | Taxi | `/m/0pg52` |
| vehicle | Ambulance | `/m/012n7d` |
| vehicle | Limousine | `/m/01lcw4` |
| vehicle | Motorcycle | `/m/04_sv` |
| vehicle | Golf cart | `/m/0323sq` |
| vehicle | Land vehicle | `/m/01prls` |
| vehicle | Vehicle | `/m/07yv9` |
| pet | Dog | `/m/0bt9lr` |
| pet | Cat | `/m/01yrx` |
| pet | Animal | `/m/0jbk` |
| pet | Mammal | `/m/04rky` |
| pet | Carnivore | `/m/01lrl` |

## Not mapped (yet)

- Human face: part of a person, not a separate one.
- Bicycle: the camera's "vehicle" means motor vehicles.
- Bird, Horse and other animals: the camera's "pet" means dog and cat.
- All other classes (furniture, clothing, household items and so on): not what
  the camera's person, vehicle and pet detection is about.

## Extending

Pick a class from [open-images-boxable-classes.csv](open-images-boxable-classes.csv)
(600 rows `mid,name`, fetched 2026-09-30 from
https://storage.googleapis.com/openimages/v5/class-descriptions-boxable.csv),
add it to `TABLE` in `src/analytics/classes.ts` with a test, and check the
Status card "objects seen, not mapped" for candidates.
