/** Search request for HubSpot CRM search API (contacts). */
export interface SearchRecordsDto {
  query: string;
  properties?: string[];
}

/** Contact properties for create/update (HubSpot uses lowercase property names). */
export interface ContactPropertiesDto {
  email?: string;
  firstname?: string;
  lastname?: string;
  jobtitle?: string;
  company?: string;
  hubspot_owner_id?: string;
  lifecyclestage?: string;
  hs_lead_status?: string;
  additionalFields?: Record<string, string>;
}

export interface CreateContactDto {
  properties: ContactPropertiesDto;
}

export interface UpdateContactDto {
  properties: Partial<ContactPropertiesDto>;
}
