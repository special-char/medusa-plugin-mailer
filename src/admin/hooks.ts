import { useAdminCustomQuery, useAdminCustomPost, useAdminCustomDelete } from "medusa-react"

export const useSesTemplate = function(id: string) {
   return useAdminCustomQuery (`/admin/mailer/templates/${id}`, ["mailer", id])
}

export const useSesTemplatePreview = (id: string) => {
   return useAdminCustomQuery (`/admin/mailer/templates/${id}/preview`, ["mailer", id])
}

export const useSesTemplateDelete = (id: string) => {
   return useAdminCustomDelete (`/admin/mailer/templates/${id}`, ["mailer", id])
}

export const useSesTemplateCreate = ({ templateId, subject, html, text }) => {
   return useAdminCustomPost (`/admin/mailer/templates`, ["mailer", "create"])
}

export const useSesTemplateUpdate = ({ templateId, subject, html, text }) => {
   return useAdminCustomPost (`/admin/mailer/templates/${templateId}`, ["mailer", "update"])
}

export const useSesTemplates = () => {
   return useAdminCustomQuery (`/admin/mailer/templates`, ["mailer", "list"])
}