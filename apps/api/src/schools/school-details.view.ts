export interface SchoolDetailsRow {
  homepage_url: string | null;
  phone_number: string | null;
  road_address: string | null;
  road_address_detail: string | null;
}

export interface SchoolDetailsView {
  school_address: string | null;
  school_homepage_url: string | null;
  school_phone_number: string | null;
}

export function schoolDetailsView(school: SchoolDetailsRow): SchoolDetailsView {
  const address = [school.road_address, school.road_address_detail]
    .filter((value): value is string => value !== null)
    .join(" ");
  return {
    school_address: address === "" ? null : address,
    school_homepage_url: school.homepage_url,
    school_phone_number: school.phone_number,
  };
}
