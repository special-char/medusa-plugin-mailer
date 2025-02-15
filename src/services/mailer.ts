import Handlebars from "handlebars";
import nodemailer from "nodemailer";
import path from "path";
import fs from "fs";
import { readdir } from "node:fs/promises";
import { exec } from "child_process";
import { NotificationService } from "medusa-interfaces";
import { MedusaError } from "@medusajs/utils";
import validEvents from "../constants/validEvents";

export interface SESOptions {
  auth_user: string;
  auth_pass: string;
  region: string;
  from: string;
  template_path?: string;
  partial_path?: string;
  order_placed_cc?: string;
  localization?: any;
  enable_endpoint?: string;
  enable_sim_mode?: boolean;
  enableUI?: boolean;
}

interface SendOptions {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: any[];
}

class SESService extends NotificationService {
  static identifier = "mailer";

  protected readonly notificationDataService_: any;
  private options_: SESOptions;
  private templatePath_: string;
  private partialPath_: string;
  private transporter_: nodemailer.Transporter;

  constructor({ notificationDataService }: any, options: SESOptions) {
    super();

    this.options_ = options;

    this.templatePath_ = this.options_.template_path.startsWith("/")
      ? path.resolve(this.options_.template_path) // The path given in options is absolute
      : path.join(__dirname, "../../../..", this.options_.template_path); // The path given in options is relative

    if (this.options_.partial_path) {
      this.partialPath_ = this.options_.partial_path.startsWith("/")
        ? path.resolve(this.options_.partial_path) // The path given in options is absolute
        : path.join(__dirname, "../../../..", this.options_.partial_path); // The path given in options is relative
      fs.readdirSync(this.partialPath_).forEach((filename) => {
        if (filename.endsWith(".hbs")) {
          const name = path.parse(filename).name;
          Handlebars.registerPartial(
            name,
            Handlebars.compile(
              fs.readFileSync(path.join(this.partialPath_, filename), "utf8")
            )
          );
        }
      });
    }

    this.notificationDataService_ = notificationDataService;

    this.transporter_ = nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: true,
      auth: {
        user: options.auth_user,
        pass: options.auth_pass,
      },
    });
  }

  // @ts-ignore
  async sendNotification(event, eventData, attachmentGenerator) {
    if (eventData?.no_notification) return;
    let templateId = event.split(".").join("_");
    const data = await this.notificationDataService_.fetchData(
      event,
      eventData,
      attachmentGenerator
    );
    if (!data.email) return;
    if (data.locale) {
      templateId =
        this.getLocalizedTemplateId(event, data.locale) || templateId;
    }

    const { subject, html, text } = await this.compileTemplate(
      templateId,
      data
    );
    if (!subject || (!html && !text)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "SES service: The requested templates were not found. Check template path in config."
      );
    }

    let sendOptions: SendOptions = {
      from: this.options_.from,
      to: data.email,
      subject,
      html,
      text,
    };

    const attachments = await this.notificationDataService_.fetchAttachments(
      event,
      data,
      attachmentGenerator
    );

    if (attachments?.length) {
      sendOptions.attachments = attachments.map((a) => {
        return {
          content: a.base64,
          filename: a.name,
          encoding: "base64",
          contentType: a.type,
        };
      });
    }

    //const status = await this.transporter_.sendMail(sendOptions).then(() => "sent").catch(() => "failed")
    let status;
    await this.transporter_
      .sendMail(sendOptions)
      .then(() => {
        status = "sent";
      })
      .catch((error) => {
        status = "failed";
        console.log(error);
      });

    if (event === "order.placed" && this.options_.order_placed_cc) {
      const recipients = this.options_.order_placed_cc.split(",");
      for (let recipient of recipients) {
        recipient = recipient.trim();
        await this.transporter_.sendMail({
          ...sendOptions,
          to: recipient,
          subject: `[CC] ${sendOptions.subject}`,
        });
      }
    }

    // We don't want heavy docs stored in DB
    delete sendOptions.attachments;

    return { to: data.email, status, data: sendOptions };
  }

  // @ts-ignore
  async resendNotification(notification, config, attachmentGenerator) {
    let sendOptions: SendOptions = {
      ...notification.data,
      to: config.to || notification.to,
    };

    const attachs = await this.notificationDataService_.fetchAttachments(
      notification.event_name,
      notification.data.dynamic_template_data,
      attachmentGenerator
    );

    sendOptions.attachments = attachs.map((a) => {
      return {
        content: a.base64,
        filename: a.name,
        encoding: "base64",
        contentType: a.type,
      };
    });

    //const status = await this.transporter_.sendMail(sendOptions).then(() => "sent").catch(() => "failed")
    let status;
    await this.transporter_
      .sendMail(sendOptions)
      .then(() => {
        status = "sent";
      })
      .catch((error) => {
        status = "failed";
        console.log(error);
      });

    return { to: sendOptions.to, status, data: sendOptions };
  }

  /**
   * Sends an email using SES.
   * @param {string} template_id - id of template to use
   * @param {string} from - sender of email
   * @param {string} to - receiver of email
   * @param {Object} data - data to send in mail (match with template)
   * @param {boolean} fromEndpoint - whether the request came from the API endpoint {default: false}
   * @return {Promise} result of the send operation
   */
  async sendEmail(
    template_id,
    from,
    to,
    data,
    from_endpoint = false,
    force_sim_mode = false
  ) {
    // This function is used by the /mailer/send API endpoint included in this plugin.
    // The endpoint is disabled by default.
    try {
      const { subject, html, text } = await this.compileTemplate(
        template_id,
        data
      );
      if (!subject || (!html && !text)) {
        return {
          message:
            "Message not sent. Templates were not found or a compile error was encountered.",
          results: {
            subject,
            html,
            text,
          },
        };
      }
      if ((from_endpoint && this.options_.enable_sim_mode) || force_sim_mode) {
        return {
          message: "Message could have been sent.",
          results: {
            subject,
            html,
            text,
          },
        };
      } else {
        return this.transporter_.sendMail({
          from: from,
          to: to,
          subject,
          html,
          text,
        });
      }
    } catch (error) {
      throw error;
    }
  }

  async compileTemplate(templateId, data) {
    const subjectTemplate = fs.existsSync(
      path.join(this.templatePath_, templateId, "subject.hbs")
    )
      ? Handlebars.compile(
          fs.readFileSync(
            path.join(this.templatePath_, templateId, "subject.hbs"),
            "utf8"
          )
        )
      : null;

    const htmlTemplate = fs.existsSync(
      path.join(this.templatePath_, templateId, "html.hbs")
    )
      ? Handlebars.compile(
          fs.readFileSync(
            path.join(this.templatePath_, templateId, "html.hbs"),
            "utf8"
          )
        )
      : null;

    const textTemplate = fs.existsSync(
      path.join(this.templatePath_, templateId, "text.hbs")
    )
      ? Handlebars.compile(
          fs.readFileSync(
            path.join(this.templatePath_, templateId, "text.hbs"),
            "utf8"
          )
        )
      : null;

    return {
      subject: subjectTemplate ? subjectTemplate(data) : "",
      html: htmlTemplate ? htmlTemplate(data) : "",
      text: textTemplate ? textTemplate(data) : "",
    };
  }

  getLocalizedTemplateId(event, locale) {
    if (this.options_.localization && this.options_.localization[locale]) {
      const map = this.options_.localization[locale];
      return map[event];
    }
    return null;
  }

  async listTemplates() {
    let templates = [];
    let files = await readdir(this.templatePath_);
    let eventIds = files.map((file) => file.replace("_", "."));
    for (let file of files) {
      const eventId = file.replace("_", ".");
      if (validEvents.includes(eventId)) {
        templates.push({
          templateId: file,
          eventId: eventId,
          subject: fs.existsSync(
            path.join(this.templatePath_, file, "subject.hbs")
          ),
          html: fs.existsSync(path.join(this.templatePath_, file, "html.hbs")),
          text: fs.existsSync(path.join(this.templatePath_, file, "text.hbs")),
          path: path.join(this.templatePath_, file),
        });
      }
    }
    const missing = validEvents.filter((event) => !eventIds.includes(event));
    return { templates, missing };
  }

  async getTemplate(templateId) {
    const subjectTemplate = fs.existsSync(
      path.join(this.templatePath_, templateId, "subject.hbs")
    )
      ? fs.readFileSync(
          path.join(this.templatePath_, templateId, "subject.hbs"),
          "utf8"
        )
      : null;

    const htmlTemplate = fs.existsSync(
      path.join(this.templatePath_, templateId, "html.hbs")
    )
      ? fs.readFileSync(
          path.join(this.templatePath_, templateId, "html.hbs"),
          "utf8"
        )
      : null;

    const textTemplate = fs.existsSync(
      path.join(this.templatePath_, templateId, "text.hbs")
    )
      ? fs.readFileSync(
          path.join(this.templatePath_, templateId, "text.hbs"),
          "utf8"
        )
      : null;

    return {
      subject: subjectTemplate,
      html: htmlTemplate,
      text: textTemplate,
    };
  }

  async deleteTemplate(templateId) {
    await exec(
      "rm " + path.join(this.templatePath_, templateId, "subject.hbs")
    );
    await exec("rm " + path.join(this.templatePath_, templateId, "html.hbs"));
    await exec("rm " + path.join(this.templatePath_, templateId, "text.hbs"));
    const result = await exec(
      "rmdir " + path.join(this.templatePath_, templateId)
    );
    return result;
  }

  async createTemplate({ templateId, subject, html, text }) {
    // check if in valid events
    await exec("mkdir " + path.join(this.templatePath_, templateId));
    await exec(
      "touch " + path.join(this.templatePath_, templateId, "subject.hbs")
    );
    await exec(
      "touch " + path.join(this.templatePath_, templateId, "html.hbs")
    );
    await exec(
      "touch " + path.join(this.templatePath_, templateId, "text.hbs")
    );
    await fs.writeFileSync(
      path.join(this.templatePath_, templateId, "subject.hbs"),
      subject
    );
    await fs.writeFileSync(
      path.join(this.templatePath_, templateId, "html.hbs"),
      html
    );
    await fs.writeFileSync(
      path.join(this.templatePath_, templateId, "text.hbs"),
      text
    );
    return { templateId, subject, html, text };
  }
}

export default SESService;
