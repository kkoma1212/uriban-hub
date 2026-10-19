export interface SchoolSearchItem {
  edu_office_code: string;
  edu_office_name: string;
  region_name: string;
  school_code: string;
  school_kind: "elementary" | "high" | "middle";
  school_name: string;
}

export interface SearchSchoolsResult {
  schools: SchoolSearchItem[];
}
