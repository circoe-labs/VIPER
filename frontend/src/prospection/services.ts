import { BuildingIcon, MailIcon, CheckCircleIcon, SparklesIcon, UsersIcon } from '../ui/icons'

export const SERVICES = [
  { code: 'iguard', label: 'IGUARD', icon: CheckCircleIcon },
  { code: 'flexisme', label: 'FLEXISME', icon: UsersIcon },
  { code: 'transepteur', label: 'TRANSEPTEUR', icon: BuildingIcon },
  { code: 'iadvice', label: 'IADVICE', icon: SparklesIcon },
  { code: 'emailing', label: 'EMAILING', icon: MailIcon },
] as const
